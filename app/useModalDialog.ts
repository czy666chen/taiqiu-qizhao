"use client";

import { useEffect, useRef } from "react";

export function useModalDialog(onDismiss?: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dismissRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      dismissRef.current();
    };
    if (!dialog.open) dialog.showModal();
    dialog.addEventListener("keydown", handleKeyDown);

    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      if (dialog.open) dialog.close();
      trigger?.focus({ preventScroll: true });
    };
  }, []);

  return dialogRef;
}
