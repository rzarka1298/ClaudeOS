import type { ResearchReportResponse } from "@ccc/domain/research-routes.js";
import { type Mock, vi } from "vitest";
import { type ResearchApi, ResearchApiError, type ResearchHostPorts } from "../research/api.js";
import { EMPTY_STATUS, listOf, runResponse } from "./research-view-fixtures.js";

export type FakeResearchApi = { [K in keyof ResearchApi]: Mock };

/** A research API whose every function is a spy with a sensible default answer. */
export function fakeResearchApi(overrides: Partial<ResearchApi> = {}): FakeResearchApi {
  const api = {
    run: vi.fn(() => Promise.resolve(runResponse())),
    status: vi.fn(() => Promise.resolve(EMPTY_STATUS)),
    list: vi.fn(() => Promise.resolve(listOf([]))),
    report: vi.fn(
      (): Promise<ResearchReportResponse> => Promise.reject(new ResearchApiError("not-found")),
    ),
    ...overrides,
  };
  return api as FakeResearchApi;
}

export type FakeResearchPorts = { [K in keyof ResearchHostPorts]: Mock };

export function fakeResearchPorts(overrides: Partial<ResearchHostPorts> = {}): FakeResearchPorts {
  return {
    notify: vi.fn(),
    openNote: vi.fn(() => true),
    copyText: vi.fn(() => true),
    requestRunNow: vi.fn(),
    ...overrides,
  } as FakeResearchPorts;
}
