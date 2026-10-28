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

  describe("paths with spaces and other shapes that used to leak the user name (FIX2A R1)", () => {
    const SPACED_HOME = "/Users/USERNAME TWO";

    it("maps a configured home folder that contains a space to ~", () => {
      const shown = displayReason(
        "connect ENOENT /Users/USERNAME TWO/.ccc/service.sock",
        SPACED_HOME,
      );
      expect(shown).toBe("connect ENOENT ~/.ccc/service.sock");
      expect(shown).not.toContain("USERNAME");
      expect(shown).not.toContain("TWO");
      expect(displayReason("home is /Users/USERNAME TWO.", SPACED_HOME)).toBe("home is ~.");
    });

    it("hides a spaced user folder when no home is configured", () => {
      const shown = displayReason("socket '/Users/USERNAME TWO/.ccc/service.sock' gone", null);
      expect(shown).toBe("socket '…/.ccc/service.sock' gone");
      expect(shown).not.toContain("USERNAME");
      expect(shown).not.toContain("TWO");
      expect(displayReason("connect ENOENT /Users/USERNAME TWO/.ccc/service.sock", null)).toBe(
        "connect ENOENT …/.ccc/service.sock",
      );
    });

    it("hides the user segment of a path on another volume", () => {
      for (const home of [null, "/Users/USERNAME"]) {
        const shown = displayReason("x /Volumes/Macintosh HD/Users/USERNAME/s.sock", home);
        expect(shown).toBe("x …/s.sock");
        expect(shown).not.toContain("USERNAME");
      }
    });

    it("never shows the segment directly under /Users or /home when there is no home folder", () => {
      expect(displayReason("see /Users/USERNAME/s.sock", null)).toBe("see …/s.sock");
      expect(displayReason("see /home/jane/s.sock", null)).toBe("see …/s.sock");
      expect(displayReason("see /Users/USERNAME", null)).toBe("see …");
      // The rule also covers another user's folder when a home folder is configured.
      expect(displayReason("see /Users/you/s.sock", "/Users/USERNAME")).toBe("see …/s.sock");
      // Deeper paths still show their last two segments.
      expect(displayReason("see /Users/USERNAME/a/s.sock", null)).toBe("see …/a/s.sock");
    });

    it("does not mistake a sibling folder for the home folder", () => {
      const shown = displayReason("see /Users/USERNAME TWO2/a/b/s.sock", SPACED_HOME);
      expect(shown).toBe("see …/b/s.sock");
    });

    it("scrubs the ~user form", () => {
      const shown = displayReason("open ~USERNAME/a/s.sock now", "/Users/USERNAME");
      expect(shown).toBe("open …/s.sock now");
    });

    it("scrubs file:// URLs, including percent-encoded spaces", () => {
      expect(displayReason("see file:///Users/USERNAME TWO/.ccc/s.sock", SPACED_HOME)).toBe(
        "see ~/.ccc/s.sock",
      );
      expect(displayReason("see file:///Users/USERNAME%20TWO/.ccc/s.sock", SPACED_HOME)).toBe(
        "see ~/.ccc/s.sock",
      );
      const shown = displayReason("see file:///Users/USERNAME%20TWO/.ccc/s.sock", null);
      expect(shown).toBe("see …/.ccc/s.sock");
      expect(shown).not.toContain("file:");
    });

    it("shows a /private/var path by its last two segments", () => {
      expect(displayReason("EACCES /private/var/folders/zz/T/svc.sock", SPACED_HOME)).toBe(
        "EACCES …/T/svc.sock",
      );
    });

    it("scrubs a Windows user folder too", () => {
      const shown = displayReason("ENOENT C:\\Users\\USERNAME TWO\\AppData\\x.sock", null);
      expect(shown).toBe("ENOENT …\\x.sock");
      expect(displayReason("ENOENT C:\\Users\\USERNAME", null)).toBe("ENOENT …");
    });

    it("keeps unrelated words around a path that has no spaces", () => {
      expect(displayReason("tried /a/one.sock then /var/run/two.sock", null)).toBe(
        "tried …/a/one.sock then …/run/two.sock",
      );
      expect(displayReason("EACCES /tmp/x.sock after retry", HOME)).toBe(
        "EACCES …/tmp/x.sock after retry",
      );
    });
  });
});
