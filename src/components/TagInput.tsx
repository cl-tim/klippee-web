import { X } from "lucide-react";
import { TextInput, UnstyledButton } from "@mantine/core";
import { useMemo, useState, type KeyboardEvent } from "react";
import { FieldLabel } from "./FieldHelp";

type TagInputProps = {
  className?: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  suggestions: string[];
  value: string;
};

function parseValues(value: string) {
  const seen = new Set<string>();
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => {
      const normalized = item.toLowerCase();
      if (!item || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

export function TagInput({
  className = "",
  id,
  label,
  onChange,
  placeholder,
  suggestions,
  value,
}: TagInputProps) {
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const selectedValues = useMemo(() => parseValues(value), [value]);
  const suggestionList = useMemo(() => {
    const selected = new Set(selectedValues.map((item) => item.toLowerCase()));
    const query = draft.trim().toLowerCase();
    const seen = new Set<string>();
    return suggestions
      .map((item) => item.trim())
      .filter((item) => {
        const normalized = item.toLowerCase();
        if (!item || selected.has(normalized) || seen.has(normalized)) return false;
        seen.add(normalized);
        return !query || normalized.includes(query);
      })
      .slice(0, 8);
  }, [draft, selectedValues, suggestions]);
  const listboxId = `${id}-suggestions`;
  const activeSuggestionId = open && suggestionList.length
    ? `${listboxId}-${activeSuggestionIndex}`
    : undefined;

  function emit(nextValues: string[]) {
    onChange(nextValues.join(", "));
  }

  function addValue(rawValue: string) {
    const nextValue = rawValue.trim().replace(/,+$/, "").trim();
    if (!nextValue) return;
    if (!selectedValues.some((item) => item.toLowerCase() === nextValue.toLowerCase())) {
      emit([...selectedValues, nextValue]);
    }
    setDraft("");
    setActiveSuggestionIndex(0);
    setOpen(true);
  }

  function removeValue(valueToRemove: string) {
    emit(selectedValues.filter((item) => item !== valueToRemove));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && suggestionList.length) {
      event.preventDefault();
      setActiveSuggestionIndex((current) => Math.min(current + 1, suggestionList.length - 1));
      return;
    }
    if (event.key === "ArrowUp" && suggestionList.length) {
      event.preventDefault();
      setActiveSuggestionIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter" && draft.trim()) {
      event.preventDefault();
      addValue(open && suggestionList.length ? suggestionList[activeSuggestionIndex] : draft);
      return;
    }
    if (event.key === "," && draft.trim()) {
      event.preventDefault();
      addValue(draft);
      return;
    }
    if (event.key === "Backspace" && !draft && selectedValues.length) {
      removeValue(selectedValues[selectedValues.length - 1]);
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className={`field metadata-tag-field${className ? ` ${className}` : ""}`}>
      <FieldLabel label={label} htmlFor={id}>Choose a suggestion or type your own, then press Enter.</FieldLabel>
      <div className="metadata-tag-input">
        <div className="metadata-tag-control">
          {selectedValues.map((item) => (
            <span className="metadata-chip" key={item}>
              <span>{item}</span>
              <UnstyledButton
                aria-label={`Remove ${label.toLowerCase()} ${item}`}
                onClick={() => removeValue(item)}
                style={{ alignItems: "center", background: "transparent", border: 0, color: "var(--muted-foreground)", cursor: "pointer", display: "inline-flex", height: 44, justifyContent: "center", minWidth: 44, padding: 0, width: 44 }}
                type="button"
              >
                <X size={12} />
              </UnstyledButton>
            </span>
          ))}
          <TextInput
            aria-autocomplete="list"
            aria-activedescendant={activeSuggestionId}
            aria-controls={open && suggestionList.length ? listboxId : undefined}
            aria-expanded={open && suggestionList.length > 0}
            autoComplete="off"
            id={id}
            onBlur={() => {
              if (draft.trim()) addValue(draft);
              setOpen(false);
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              setActiveSuggestionIndex(0);
              setOpen(true);
            }}
            onFocus={() => {
              setActiveSuggestionIndex(0);
              setOpen(true);
            }}
            onKeyDown={handleKeyDown}
            placeholder={selectedValues.length ? "Add another…" : placeholder}
            role="combobox"
            style={{ flex: 1, minWidth: 100 }}
            styles={{ input: { background: "transparent", border: 0, color: "var(--foreground)", height: 44, outline: 0, padding: 0 } }}
            variant="unstyled"
            value={draft}
          />
        </div>
        {open && suggestionList.length ? (
          <div aria-label={`${label} suggestions`} className="metadata-tag-suggestions" id={listboxId} role="listbox">
            {suggestionList.map((suggestion, index) => (
              <UnstyledButton
                aria-selected={activeSuggestionIndex === index}
                className={activeSuggestionIndex === index ? "is-active" : undefined}
                id={`${listboxId}-${index}`}
                key={suggestion}
                onClick={() => addValue(suggestion)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveSuggestionIndex(index)}
                role="option"
                style={{ alignItems: "center", background: activeSuggestionIndex === index ? "var(--accent)" : "transparent", border: 0, color: "var(--foreground)", cursor: "pointer", display: "flex", font: "inherit", justifyContent: "flex-start", minHeight: 44, padding: "8px 10px", textAlign: "left", width: "100%" }}
                tabIndex={-1}
                type="button"
              >
                {suggestion}
              </UnstyledButton>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
