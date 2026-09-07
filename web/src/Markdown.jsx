// Just enough markdown for the assistant's replies — bullets, numbered lists,
// bold and inline code. Written out rather than pulled from a dependency
// because the model is prompted for "short prose or compact lists", and this
// builds React elements instead of HTML strings so there is nothing to inject.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function renderInline(text, keyPrefix) {
  return text.split(INLINE).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

export default function Markdown({ text }) {
  const blocks = [];
  let list = null;

  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={`list-${blocks.length}`}>
        {list.items.map((item, index) => (
          <li key={index}>{renderInline(item, `li-${blocks.length}-${index}`)}</li>
        ))}
      </Tag>
    );
    list = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      // A change of list type starts a new list rather than mixing markers.
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
      continue;
    }

    flush();
    if (!line.trim()) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    blocks.push(
      heading ? (
        <h4 key={`h-${blocks.length}`}>{renderInline(heading[1], `h-${blocks.length}`)}</h4>
      ) : (
        <p key={`p-${blocks.length}`}>{renderInline(line, `p-${blocks.length}`)}</p>
      )
    );
  }

  flush();
  return <>{blocks}</>;
}
