import type { ResearchSourcesConfig } from "@ccc/domain";

/**
 * The allowlist the first run seeds into `<runtimeDir>/research-sources.json` (OD-2, D-07): the
 * default topic and public release-note feeds of developer tooling, all of which were checked
 * reachable in research. These are public addresses, not personal data. The file is the owner's
 * from then on and is edited by hand until a later settings view; nothing here is read after the
 * file exists. Tests and fixtures never use these addresses (they use reserved `.invalid` hosts).
 */
export const DEFAULT_RESEARCH_CONFIG: ResearchSourcesConfig = {
  topicLabel: "Developer tooling and open-source releases",
  summariserModel: "claude-haiku-5-5",
  sources: [
    { label: "Node.js releases", url: "https://nodejs.org/en/feed/releases.xml", kind: "feed" },
    { label: "Rust blog", url: "https://blog.rust-lang.org/feed.xml", kind: "feed" },
    {
      label: "TypeScript devblog",
      url: "https://devblogs.microsoft.com/typescript/feed/",
      kind: "feed",
    },
    { label: "Go blog", url: "https://go.dev/blog/feed.atom", kind: "feed" },
    { label: "Vite releases", url: "https://github.com/vitejs/vite/releases.atom", kind: "feed" },
    { label: "GitHub changelog", url: "https://github.blog/changelog/feed/", kind: "feed" },
  ],
};
