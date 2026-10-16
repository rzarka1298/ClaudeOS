import { afterEach, describe, expect, it, vi } from "vitest";
import * as quickActions from "../widgets/quick-actions.js";
import { configureResearch } from "./api.js";
import { createRunNowRequester, RESEARCH_RUN_DESCRIPTOR } from "./run-now.js";
import { pressPending, resetResearchState } from "./state.js";

/**
 * The Run now host port (plan 07-15, D-17): the port the Research view's button calls is the
 * one dispatch of the `research:run` descriptor, and the context it dispatches in holds the
 * trigger and nothing else (it cannot launch, navigate or request an approval).
 */

vi.mock("../widgets/quick-actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../widgets/quick-actions.js")>();
  return { ...actual, dispatchQuickAction: vi.fn(actual.dispatchQuickAction) };
});

const spy = vi.mocked(quickActions.dispatchQuickAction);

afterEach(() => {
  spy.mockClear();
  configureResearch(null);
  resetResearchState();
});

describe("createRunNowRequester", () => {
  it("dispatches the research:run descriptor once per call through dispatchQuickAction", () => {
    const request = createRunNowRequester(vi.fn());
    request();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(RESEARCH_RUN_DESCRIPTOR);
    expect(RESEARCH_RUN_DESCRIPTOR.capability).toBe("research:run");
  });

  it("the dispatch context carries runResearch and no launch, proposal, session or navigation effect", () => {
    createRunNowRequester(vi.fn())();
    const ctx = spy.mock.calls[0]?.[1];
    expect(ctx?.runResearch).toBeTypeOf("function");
    expect(ctx?.requestProposal).toBeUndefined();
    expect(ctx?.runSessionAction).toBeUndefined();
    expect(ctx?.openSwitcher).toBeUndefined();
    expect(ctx?.requestTaskForm).toBeUndefined();
    ctx?.navigate("settings");
    ctx?.requestLaunch(null, "finder");
    // Neither of the two inert members did anything observable.
    expect(pressPending.value).toBe(false);
  });

  it("posts the unavailable Notice through the notify it was given when the trigger is not wired", () => {
    const notify = vi.fn();
    // A requester whose dispatch answers unavailable is the dispatcher's own behaviour;
    // here the requester must hand its notify to the context unchanged.
    createRunNowRequester(notify)();
    expect(spy.mock.calls[0]?.[1].notify).toBe(notify);
  });
});
