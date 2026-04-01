import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PendingQuestion } from "@/lib/store/useSessionStore";

interface QuestionCardProps {
  question: PendingQuestion;
  onAnswer: (questionId: string, answer: string) => void;
}

export function QuestionCard({ question, onAnswer }: QuestionCardProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    if (!value.trim()) return;
    onAnswer(question.questionId, value.trim());
  };

  const handleOption = (option: string) => {
    setValue(option);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[80%] w-full rounded-lg border border-blue-500/30 bg-blue-950/20 text-sm">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-blue-500/20">
          <HelpCircle className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          <span className="text-xs font-medium text-blue-400 uppercase tracking-wide">
            Claude is asking…
          </span>
        </div>

        {/* Question */}
        <div className="px-4 py-3 text-foreground font-medium">
          {question.question}
        </div>

        {/* Option chips */}
        {question.options && question.options.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-3">
            {question.options.map((opt) => (
              <button
                key={opt}
                onClick={() => handleOption(opt)}
                className={cn(
                  "px-3 py-1 rounded-full border text-xs transition-colors",
                  value === opt
                    ? "border-blue-500 bg-blue-500/20 text-blue-300"
                    : "border-border text-muted-foreground hover:border-blue-500/50 hover:text-foreground"
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        {/* Input + submit */}
        <div className="px-4 pb-4 flex gap-2 items-end">
          <textarea
            rows={2}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKey}
            placeholder={question.placeholder ?? "Your answer…"}
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            onClick={submit}
            disabled={!value.trim()}
            className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
