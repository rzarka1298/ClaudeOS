import { describe, expect, it } from "vitest";
import { envProxyRequested } from "./proxy-env.js";

describe("envProxyRequested (research Pitfall 4)", () => {
  it("is false for a plain environment", () => {
    expect(envProxyRequested({}, [])).toBe(false);
    expect(envProxyRequested({ PATH: "/usr/bin" }, ["--max-old-space-size=512"])).toBe(false);
  });

  for (const value of ["1", "true", "yes", "on", "TRUE", " 1 "]) {
    it(`is true when NODE_USE_ENV_PROXY is ${JSON.stringify(value)}`, () => {
      expect(envProxyRequested({ NODE_USE_ENV_PROXY: value }, [])).toBe(true);
    });
  }

  for (const value of ["", "0", undefined]) {
    it(`is false when NODE_USE_ENV_PROXY is ${JSON.stringify(value)}`, () => {
      expect(envProxyRequested({ NODE_USE_ENV_PROXY: value }, [])).toBe(false);
    });
  }

  it("is true when the process was started with --use-env-proxy", () => {
    expect(envProxyRequested({}, ["--use-env-proxy"])).toBe(true);
    expect(envProxyRequested({}, ["--no-warnings", "--use-env-proxy"])).toBe(true);
  });

  it("is true when NODE_OPTIONS carries --use-env-proxy", () => {
    expect(envProxyRequested({ NODE_OPTIONS: "--use-env-proxy" }, [])).toBe(true);
    expect(envProxyRequested({ NODE_OPTIONS: "--max-old-space-size=1 --use-env-proxy" }, [])).toBe(
      true,
    );
    expect(envProxyRequested({ NODE_OPTIONS: "--max-old-space-size=1" }, [])).toBe(false);
  });

  it("is false for proxy variables alone: the explicit agent is not rerouted without the flag", () => {
    expect(
      envProxyRequested(
        { HTTPS_PROXY: "http://proxy.invalid:3128", https_proxy: "http://proxy.invalid:3128" },
        [],
      ),
    ).toBe(false);
  });
});
