/**
 * Copyright © 2022 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { getConfig } from '@expo/config';
import { prependMiddleware } from '@expo/dev-server';
import assert from 'assert';

import getDevClientProperties from '../../../utils/analytics/getDevClientProperties';
import { logEventAsync } from '../../../utils/analytics/rudderstackClient';
import { env } from '../../../utils/env';
import { getFreePortAsync } from '../../../utils/port';
import { BundlerDevServer, BundlerStartOptions, DevServerInstance } from '../BundlerDevServer';
import { getStaticRenderFunctions } from '../getStaticRenderFunctions';
import { CreateFileMiddleware } from '../middleware/CreateFileMiddleware';
import { HistoryFallbackMiddleware } from '../middleware/HistoryFallbackMiddleware';
import { InterstitialPageMiddleware } from '../middleware/InterstitialPageMiddleware';
import {
  DeepLinkHandler,
  RuntimeRedirectMiddleware,
} from '../middleware/RuntimeRedirectMiddleware';
import { ServeStaticMiddleware } from '../middleware/ServeStaticMiddleware';
import { ServerNext, ServerRequest, ServerResponse } from '../middleware/server.types';
import { instantiateMetroAsync } from './instantiateMetro';

/** Default port to use for apps running in Expo Go. */
const EXPO_GO_METRO_PORT = 19000;

/** Default port to use for apps that run in standard React Native projects or Expo Dev Clients. */
const DEV_CLIENT_METRO_PORT = 8081;

export class MetroBundlerDevServer extends BundlerDevServer {
  get name(): string {
    return 'metro';
  }

  async resolvePortAsync(options: Partial<BundlerStartOptions> = {}): Promise<number> {
    const port =
      // If the manually defined port is busy then an error should be thrown...
      options.port ??
      // Otherwise use the default port based on the runtime target.
      (options.devClient
        ? // Don't check if the port is busy if we're using the dev client since most clients are hardcoded to 8081.
          Number(process.env.RCT_METRO_PORT) || DEV_CLIENT_METRO_PORT
        : // Otherwise (running in Expo Go) use a free port that falls back on the classic 19000 port.
          await getFreePortAsync(EXPO_GO_METRO_PORT));

    return port;
  }

  /** Get routes from Expo Router. */
  async getRoutesAsync() {
    const url = this.getDevServerUrl();
    assert(url, 'Dev server must be started');
    const { getManifest } = await getStaticRenderFunctions(this.projectRoot, url);
    return getManifest();
  }

  protected async startImplementationAsync(
    options: BundlerStartOptions
  ): Promise<DevServerInstance> {
    options.port = await this.resolvePortAsync(options);
    this.urlCreator = this.getUrlCreator(options);

    const parsedOptions = {
      port: options.port,
      maxWorkers: options.maxWorkers,
      resetCache: options.resetDevServer,

      // Use the unversioned metro config.
      // TODO: Deprecate this property when expo-cli goes away.
      unversioned: false,
    };

    const { server, middleware, messageSocket } = await instantiateMetroAsync(
      this.projectRoot,
      parsedOptions
    );

    const manifestMiddleware = await this.getManifestMiddlewareAsync(options);

    // We need the manifest handler to be the first middleware to run so our
    // routes take precedence over static files. For example, the manifest is
    // served from '/' and if the user has an index.html file in their project
    // then the manifest handler will never run, the static middleware will run
    // and serve index.html instead of the manifest.
    // https://github.com/expo/expo/issues/13114

    prependMiddleware(middleware, manifestMiddleware.getHandler());

    middleware.use(
      new InterstitialPageMiddleware(this.projectRoot, {
        // TODO: Prevent this from becoming stale.
        scheme: options.location.scheme ?? null,
      }).getHandler()
    );

    const deepLinkMiddleware = new RuntimeRedirectMiddleware(this.projectRoot, {
      onDeepLink: getDeepLinkHandler(this.projectRoot),
      getLocation: ({ runtime }) => {
        if (runtime === 'custom') {
          return this.urlCreator?.constructDevClientUrl();
        } else {
          return this.urlCreator?.constructUrl({
            scheme: 'exp',
          });
        }
      },
    });
    middleware.use(deepLinkMiddleware.getHandler());

    middleware.use(new CreateFileMiddleware(this.projectRoot).getHandler());

    // Append support for redirecting unhandled requests to the index.html page on web.
    if (this.isTargetingWeb()) {
      // This MUST be after the manifest middleware so it doesn't have a chance to serve the template `public/index.html`.
      middleware.use(new ServeStaticMiddleware(this.projectRoot).getHandler());

      const devServerUrl = `http://localhost:${options.port}`;

      if (env.EXPO_USE_STATIC) {
        middleware.use(async (req: ServerRequest, res: ServerResponse, next: ServerNext) => {
          if (!req?.url) {
            return next();
          }

          // TODO: Formal manifest for allowed paths
          if (req.url.endsWith('.ico')) {
            return next();
          }

          const location = new URL(req.url, devServerUrl);

          try {
            const getStaticContent = (
              await getStaticRenderFunctions(this.projectRoot, devServerUrl, {
                minify: options.mode === 'production',
                dev: options.mode !== 'production',
              })
            ).getStaticContent;

            let content = getStaticContent(location);

            //TODO: Not this -- disable injection some other way
            if (options.mode !== 'production') {
              // Add scripts for rehydration
              // TODO: bundle split
              content = content.replace(
                '</body>',
                [`<script src="${manifestMiddleware.getWebBundleUrl()}" defer></script>`].join(
                  '\n'
                ) + '</body>'
              );
            }

            res.setHeader('Content-Type', 'text/html');
            res.end(content);
            return;
          } catch (error: any) {
            console.error(error);
            res.setHeader('Content-Type', 'text/html');
            res.end(getErrorResult(error));
          }
        });
      }

      // This MUST run last since it's the fallback.
      if (!env.EXPO_USE_STATIC) {
        middleware.use(
          new HistoryFallbackMiddleware(manifestMiddleware.getHandler().internal).getHandler()
        );
      }
    }
    // Extend the close method to ensure that we clean up the local info.
    const originalClose = server.close.bind(server);

    server.close = (callback?: (err?: Error) => void) => {
      return originalClose((err?: Error) => {
        this.instance = null;
        callback?.(err);
      });
    };

    return {
      server,
      location: {
        // The port is the main thing we want to send back.
        port: options.port,
        // localhost isn't always correct.
        host: 'localhost',
        // http is the only supported protocol on native.
        url: `http://localhost:${options.port}`,
        protocol: 'http',
      },
      middleware,
      messageSocket,
    };
  }

  protected getConfigModuleIds(): string[] {
    return ['./metro.config.js', './metro.config.json', './rn-cli.config.js'];
  }
}

function getErrorResult(error: Error) {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
    <title>Error</title>
  </head>
  <body>
    <h1>Failed to render static app</h1>
    <pre>${error.stack}</pre>
  </body>
  </html>
  `;
}

export function getDeepLinkHandler(projectRoot: string): DeepLinkHandler {
  return async ({ runtime }) => {
    if (runtime === 'expo') return;
    const { exp } = getConfig(projectRoot);
    await logEventAsync('dev client start command', {
      status: 'started',
      ...getDevClientProperties(projectRoot, exp),
    });
  };
}
