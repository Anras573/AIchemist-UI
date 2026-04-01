import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuestionCard } from "@/components/session/QuestionCard";
import type { PendingQuestion } from "@/lib/store/useSessionStore";

function makeQuestion(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    questionId: "q-1",
    question: "Which approach should we use?",
    resolve: vi.fn(),
    ...overrides,
  };
}

describe("QuestionCard", () => {
  it("renders the question text", () => {
    render(<QuestionCard question={makeQuestion()} onAnswer={vi.fn()} />);
    expect(screen.getByText("Which approach should we use?")).toBeInTheDocument();
  });

  it("renders option chips when options are provided", () => {
    const q = makeQuestion({ options: ["Option A", "Option B"] });
    render(<QuestionCard question={q} onAnswer={vi.fn()} />);
    expect(screen.getByText("Option A")).toBeInTheDocument();
    expect(screen.getByText("Option B")).toBeInTheDocument();
  });

  it("does not render option chips when no options provided", () => {
    render(<QuestionCard question={makeQuestion()} onAnswer={vi.fn()} />);
    expect(screen.queryAllByRole("button").filter(b => b.textContent !== "Send")).toHaveLength(0);
  });

  it("clicking an option pre-fills the textarea", () => {
    const q = makeQuestion({ options: ["Option A", "Option B"] });
    render(<QuestionCard question={q} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByText("Option A"));
    expect(screen.getByRole("textbox")).toHaveValue("Option A");
  });

  it("submit button is disabled when input is empty", () => {
    render(<QuestionCard question={makeQuestion()} onAnswer={vi.fn()} />);
    expect(screen.getByText("Send")).toBeDisabled();
  });

  it("submit button is enabled after typing", () => {
    render(<QuestionCard question={makeQuestion()} onAnswer={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my answer" } });
    expect(screen.getByText("Send")).toBeEnabled();
  });

  it("calls onAnswer with questionId and trimmed value on submit", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard question={makeQuestion()} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  my answer  " } });
    fireEvent.click(screen.getByText("Send"));
    expect(onAnswer).toHaveBeenCalledWith("q-1", "my answer");
  });

  it("calls onAnswer when Enter is pressed (without Shift)", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard question={makeQuestion()} onAnswer={onAnswer} />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "my answer" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onAnswer).toHaveBeenCalledWith("q-1", "my answer");
  });

  it("does not call onAnswer when Shift+Enter is pressed", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard question={makeQuestion()} onAnswer={onAnswer} />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "my answer" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("uses the placeholder prop on the textarea", () => {
    const q = makeQuestion({ placeholder: "Type your choice here…" });
    render(<QuestionCard question={q} onAnswer={vi.fn()} />);
    expect(screen.getByPlaceholderText("Type your choice here…")).toBeInTheDocument();
  });

  it("falls back to 'Your answer…' placeholder when none provided", () => {
    render(<QuestionCard question={makeQuestion()} onAnswer={vi.fn()} />);
    expect(screen.getByPlaceholderText("Your answer…")).toBeInTheDocument();
  });
});
