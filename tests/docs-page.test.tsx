import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import DocsPage from "@/app/project/[projectId]/docs/page";

describe("DocsPage", () => {
  it("renders the empty state", () => {
    render(<DocsPage params={{ projectId: "test-project-id" }} />);
    expect(screen.getByText("No docs yet")).toBeDefined();
    expect(
      screen.getByText(/Create your first document to get started/)
    ).toBeDefined();
  });

  it("displays the docs icon", () => {
    const { container } = render(
      <DocsPage params={{ projectId: "test-project-id" }} />
    );
    const icon = container.querySelector("svg");
    expect(icon).toBeDefined();
  });
});
