/**
 * Read-only Klipper config source rendering with lightweight syntax
 * highlighting (sections, options, comments, ${KLIPPEE:...} variables).
 * Extracted from RegistryView so the public package detail view stays focused
 * on layout.
 */
export function ConfigSourceCode({ content, path }: { content: string; path: string }) {
  return (
    <pre aria-label={`Source for ${path}`} className="package-config-code" tabIndex={0}>
      <code>
        {content.split("\n").map((line, index) => (
          <span className="package-config-code-line" key={`${index}-${line}`}>
            <span aria-hidden="true" className="package-config-line-number">{index + 1}</span>
            <span className="package-config-line-source">{highlightConfigLine(line)}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}

function highlightConfigLine(line: string) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) {
    return <span className="package-config-comment">{line || " "}</span>;
  }

  const section = line.match(/^(\s*)(\[[^\]]+\])(.*)$/);
  if (section) {
    return (
      <>
        {section[1]}
        <span className="package-config-section">{section[2]}</span>
        {section[3] ? <span className="package-config-comment">{section[3]}</span> : null}
      </>
    );
  }

  const option = line.match(/^(\s*)([A-Za-z_][\w-]*)(\s*:)(.*)$/);
  if (option) {
    return (
      <>
        {option[1]}
        <span className="package-config-option">{option[2]}</span>
        {option[3]}
        {highlightConfigValue(option[4])}
      </>
    );
  }

  return line || " ";
}

function highlightConfigValue(value: string) {
  const parts = value.split(/(\$\{KLIPPEE:[a-z][a-z0-9_]*\}|#.*$)/g);
  return parts.map((part, index) => {
    if (part.startsWith("${KLIPPEE:")) {
      return <span className="package-config-variable" key={`${index}-${part}`}>{part}</span>;
    }
    if (part.startsWith("#")) {
      return <span className="package-config-comment" key={`${index}-${part}`}>{part}</span>;
    }
    return part;
  });
}
