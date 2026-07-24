export const KNOWN_OAUTH_PROVIDERS = {
  google: {
    name: "Google",
    icon: "https://assets.decocache.com/webdraw/eb7480aa-a68b-4ce4-98ff-36aa121762a7/google.svg",
  },
  github: {
    name: "GitHub",
    icon: "https://assets.decocache.com/decocms/e02ce92e-6684-41a6-acfc-432977eb4878/github.png",
  },
  microsoft: {
    name: "Microsoft",
    icon: "https://assets.decocache.com/mcp/aa6f6e1a-6526-4bca-99cc-82e2ec38b0e4/microsoft.png",
  },
};

export type OAuthProvider = keyof typeof KNOWN_OAUTH_PROVIDERS;
