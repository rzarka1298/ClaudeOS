import { describe, expect, it } from "vitest";
import { displayReason } from "./display-reason.js";

const HOME = "/Users/USERNAME";

describe("displayReason (D-11, DIAG-06)", () => {
  it("shows a path inside the home folder in ~/ form", () => {
    expect(
      displayReason("connect ENOENT /Users/USERNAME/.claude-command-center/service.sock", HOME),
    ).toBe("connect ENOENT ~/.claude-command-center/service.sock");
  });

  it("shows a path outside the home folder as the last two segments", () => {
    expect(displayReason("connect EACCES /tmp/ccc-run/svc.sock", HOME)).toBe(
      "connect EACCES …/ccc-run/svc.sock",
    );
  });

  it("replaces every absolute path when a reason carries several", () => {
    expect(displayReason("tried /Users/USERNAME/a/one.sock then /var/run/two.sock", HOME)).toBe(
      "tried ~/a/one.sock then …/run/two.sock",
    );
  });

  it("keeps trailing punctuation outside the path", () => {
    expect(displayReason("cannot reach /Users/USERNAME/x/s.sock.", HOME)).toBe(
      "cannot reach ~/x/s.sock.",
    );
    expect(displayReason("(/Users/USERNAME/x/s.sock), then retry", HOME)).toBe(
      "(~/x/s.sock), then retry",
    );
    expect(displayReason("at /Users/USERNAME/x/s.sock: refused", HOME)).toBe(
      "at ~/x/s.sock: refused",
    );
  });

  it("stops a quoted path at the quote", () => {
    expect(displayReason("socket '/Users/USERNAME/x/s.sock' is gone", HOME)).toBe(
      "socket '~/x/s.sock' is gone",
    );
  });

  it("leaves text with no path, and relative paths, unchanged", () => {
    expect(displayReason("service stopped", HOME)).toBe("service stopped");
    expect(displayReason("read logs/x failed", HOME)).toBe("read logs/x failed");
    expect(displayReason("read ./logs/x and ../y failed", HOME)).toBe(
      "read ./logs/x and ../y failed",
    );
    expect(displayReason("read ~/logs/x failed", HOME)).toBe("read ~/logs/x failed");
    expect(displayReason("a / b", HOME)).toBe("a / b");
    expect(displayReason("connect ECONNREFUSED 127.0.0.1:4000", HOME)).toBe(
      "connect ECONNREFUSED 127.0.0.1:4000",
    );
  });

  it("applies the outside rule when no home folder is configured", () => {
    const shown = displayReason(
      "connect ENOENT /Users/USERNAME/.claude-command-center/s.sock",
      null,
    );
    expect(shown).toBe("connect ENOENT …/.claude-command-center/s.sock");
    expect(shown).not.toContain("/Users/");
    expect(shown).not.toContain("USERNAME");
  });

  it("masks the user name when the home folder is configured and a path is outside it", () => {
    expect(displayReason("see /Volumes/USERNAME-backup/Vault/x", HOME)).toBe("see …/Vault/x");
  });
});
