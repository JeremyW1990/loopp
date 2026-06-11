import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders the agent's markdown replies (bold, lists, tables) inside a chat
 * bubble. SAFE BY DESIGN: react-markdown builds React elements from the parsed
 * AST and — with no `rehype-raw` — NEVER renders raw HTML. Any embedded HTML or
 * injection payload is escaped to text and link URLs are sanitized, so this
 * keeps the project's "no raw-HTML sink" guarantee while formatting nicely.
 *
 * Only ASSISTANT messages use this; user-typed messages stay plain text so an
 * injected payload is shown verbatim (see the SQL-injection edge case).
 *
 * Text color is inherited from the enclosing bubble; only structural and accent
 * styling is set here.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-2 break-words text-sm leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{children}</p>,
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => (
            <ul className="ml-4 list-disc space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="ml-4 list-decimal space-y-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-700 underline"
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-slate-200/70 px-1 py-0.5 font-mono text-[0.85em]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded bg-slate-200/70 p-2 font-mono text-xs">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-slate-300 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-slate-300 px-2 py-1 align-top">
              {children}
            </td>
          ),
          // Headings in chat are visually just emphasized lines, not page titles.
          h1: ({ children }) => <p className="font-semibold">{children}</p>,
          h2: ({ children }) => <p className="font-semibold">{children}</p>,
          h3: ({ children }) => <p className="font-semibold">{children}</p>,
          hr: () => <hr className="border-slate-200" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
