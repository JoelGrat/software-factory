// lib/preview/preview-url.ts

export interface PreviewUrlStrategy {
  getUrl(port: number): string
}

/** Local development: app runs on the same machine as FactoryOS. */
export class LocalStrategy implements PreviewUrlStrategy {
  getUrl(port: number): string {
    return `http://localhost:${port}`
  }
}

/** Default strategy — swap this out for cloud deployments. */
export const defaultStrategy: PreviewUrlStrategy = new LocalStrategy()
