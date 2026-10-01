import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * The Ackstack mark: a document whose lower half is a check mark.
 *
 * Drawn on a 24×24 grid in `currentColor`, so it takes the colour of the
 * badge it sits in (`text-primary-foreground` on `bg-primary`).
 * `src/app/icon.svg` is the same mark with fixed colours, because a favicon
 * can't read CSS variables.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-5 w-5", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 12V4.5A1.5 1.5 0 0 1 7.5 3H14l4 4v5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 3v4h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 16l4 4 8-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
