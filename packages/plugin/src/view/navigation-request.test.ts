import type { ProjectId } from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvalsHeadingRequested,
  consumeApprovalsHeadingRequest,
  consumeTaskFormRequest,
  navigationRequest,
  requestDestination,
  taskFormRequested,
} from "./navigation-request.js";

/**
 * Plan 06-10, Task 2, Test 6: one-shot navigation intents. A request from
 * outside the shell's tree can ask for the Tasks create form or the Approvals
 * heading, each consumed exactly once.
 */

afterEach(() => {
  navigationRequest.value = null;
  taskFormRequested.value = false;
  approvalsHeadingRequested.value = false;
});

describe("requestDestination", () => {
  it("keeps the existing destination-only and project-focus shapes unchanged", () => {
    requestDestination("projects");
    expect(navigationRequest.value).toEqual({ destination: "projects" });
    requestDestination("projects", { focusProjectId: "p1" as ProjectId });
    expect(navigationRequest.value).toEqual({ destination: "projects", focusProjectId: "p1" });
    expect(taskFormRequested.value).toBe(false);
    expect(approvalsHeadingRequested.value).toBe(false);
  });

  it("sets the request and the one-shot task-form intent for the create form", () => {
    requestDestination("tasks", { openTaskForm: true });
    expect(navigationRequest.value).toEqual({ destination: "tasks", openTaskForm: true });
    expect(taskFormRequested.value).toBe(true);
  });

  it("sets the approvals-heading intent for the Approvals section", () => {
    requestDestination("agent-runs", { focusApprovalsHeading: true });
    expect(navigationRequest.value).toEqual({
      destination: "agent-runs",
      focusApprovalsHeading: true,
    });
    expect(approvalsHeadingRequested.value).toBe(true);
  });

  it("carries a proposal id to focus", () => {
    requestDestination("agent-runs", { focusProposalId: "0mfk1a2b3c4d5e6f7a8b9c001" });
    expect(navigationRequest.value).toEqual({
      destination: "agent-runs",
      focusProposalId: "0mfk1a2b3c4d5e6f7a8b9c001",
    });
  });

  it("carries only the options that were set", () => {
    requestDestination("agent-runs", {
      focusApprovalsHeading: false,
      focusProposalId: undefined,
    });
    expect(navigationRequest.value).toEqual({ destination: "agent-runs" });
    expect(approvalsHeadingRequested.value).toBe(false);
  });
});

describe("the one-shot intents are consumed once", () => {
  it("consumeTaskFormRequest returns true once and false after", () => {
    expect(consumeTaskFormRequest()).toBe(false);
    requestDestination("tasks", { openTaskForm: true });
    expect(consumeTaskFormRequest()).toBe(true);
    expect(consumeTaskFormRequest()).toBe(false);
    expect(taskFormRequested.value).toBe(false);
  });

  it("consumeApprovalsHeadingRequest returns true once and false after", () => {
    expect(consumeApprovalsHeadingRequest()).toBe(false);
    requestDestination("agent-runs", { focusApprovalsHeading: true });
    expect(consumeApprovalsHeadingRequest()).toBe(true);
    expect(consumeApprovalsHeadingRequest()).toBe(false);
    expect(approvalsHeadingRequested.value).toBe(false);
  });

  it("the two intents are independent", () => {
    requestDestination("tasks", { openTaskForm: true });
    expect(consumeApprovalsHeadingRequest()).toBe(false);
    expect(taskFormRequested.value).toBe(true);
  });
});
