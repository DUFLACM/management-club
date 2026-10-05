/** 轻量训练室插画：代码窗口、笔记与节点图。所有颜色跟随主题 token。 */
export function WelcomeTrainingArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 380 280" fill="none" aria-hidden="true" className={className}>
      <path d="M64 63C94 22 148 27 188 31C245 36 307 22 327 71C347 120 335 194 282 222C229 250 149 245 98 220C47 195 34 104 64 63Z" fill="var(--secondary)" />
      <circle cx="308" cy="72" r="39" fill="var(--success-subtle)" />
      <circle cx="63" cy="190" r="23" fill="var(--lilac-subtle)" />
      <path d="M42 246H337" stroke="var(--border)" strokeWidth="1.5" strokeLinecap="round" />
      <g transform="rotate(-7 190 135)">
        <rect x="72" y="58" width="228" height="157" rx="15" fill="var(--card)" stroke="var(--border)" strokeWidth="1.5" />
        <path d="M72 89H300" stroke="var(--border)" strokeWidth="1.5" />
        <circle cx="88" cy="73" r="3.5" fill="var(--primary)" opacity=".65" />
        <circle cx="100" cy="73" r="3.5" fill="var(--success-foreground)" opacity=".5" />
        <circle cx="112" cy="73" r="3.5" fill="var(--lilac-foreground)" opacity=".5" />
        <path d="M105 120H143M105 136H169M105 152H130M139 152H158M105 168H150M105 184H176" stroke="var(--input)" strokeWidth="5" strokeLinecap="round" opacity=".55" />
        <rect x="190" y="107" width="90" height="87" rx="11" fill="var(--secondary)" />
        <path d="M219 137 209 148 219 159M249 137 259 148 249 159M239 133 229 163" stroke="var(--primary)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g transform="rotate(8 290 191)">
        <rect x="255" y="151" width="81" height="69" rx="12" fill="var(--card)" stroke="var(--border)" strokeWidth="1.5" />
        <path d="M275 190 295 171 316 198M275 190 316 198" stroke="var(--success-foreground)" strokeWidth="1.5" />
        <circle cx="275" cy="190" r="5" fill="var(--success-subtle)" stroke="var(--success-foreground)" strokeWidth="1.5" />
        <circle cx="295" cy="171" r="5" fill="var(--success-subtle)" stroke="var(--success-foreground)" strokeWidth="1.5" />
        <circle cx="316" cy="198" r="5" fill="var(--success-subtle)" stroke="var(--success-foreground)" strokeWidth="1.5" />
      </g>
      <g transform="rotate(-5 104 225)">
        <rect x="63" y="212" width="90" height="28" rx="5" fill="var(--card)" stroke="var(--input)" strokeWidth="1.5" />
        <path d="M109 214V238M72 221H99M72 228H95M118 221H143M118 228H137" stroke="var(--input)" strokeWidth="1.5" strokeLinecap="round" />
      </g>
      <path d="M47 66 50 74 58 77 50 80 47 88 44 80 36 77 44 74Z" fill="var(--primary)" opacity=".6" />
      <path d="M324 117 326 123 332 125 326 127 324 133 322 127 316 125 322 123Z" fill="var(--lilac-foreground)" opacity=".7" />
      <circle cx="177" cy="255" r="3" fill="var(--primary)" opacity=".35" />
      <circle cx="186" cy="255" r="3" fill="var(--primary)" opacity=".15" />
      <circle cx="195" cy="255" r="3" fill="var(--primary)" opacity=".15" />
    </svg>
  );
}
