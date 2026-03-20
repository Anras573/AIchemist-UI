import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { AppShell } from "@/components/layout/AppShell";
import { useProjectStore } from "@/lib/store/useProjectStore";

// Mock heavy layout children — AppShell wiring is what we're testing, not the children
vi.mock("@/components/layout/ProjectSidebar", () => ({
  ProjectSidebar: () => <div data-testid="project-sidebar" />,
}));
vi.mock("@/components/layout/WorkspaceView", () => ({
  WorkspaceView: () => <div data-testid="workspace-view" />,
}));
vi.mock("@/components/layout/CommandPalette", () => ({
  CommandPalette: () => null,
}));
vi.mock("@/components/settings/SettingsView", () => ({
  SettingsView: () => <div data-testid="settings-view" />,
}));

describe("AppShell", () => {
  it("renders the sidebar and workspace by default", () => {
    renderWithProviders(<AppShell />);
    expect(screen.getByTestId("project-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-view")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument();
  });

  it("shows SettingsView and hides WorkspaceView when settingsOpen is true", () => {
    useProjectStore.getState().openSettings();
    renderWithProviders(<AppShell />);
    expect(screen.getByTestId("settings-view")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-view")).not.toBeInTheDocument();
  });
});
