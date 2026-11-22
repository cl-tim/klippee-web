import { useRef, useState, type DragEvent as ReactDragEvent } from "react";

/**
 * File drag-and-drop state using a depth counter, so the drop highlight does
 * not flicker while dragging across child elements. Spread `dropProps` onto
 * the drop-target element and render the highlight from `isDragActive`.
 */
export function useFileDrop(onFiles: (files: FileList) => void) {
  const [isDragActive, setIsDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  function hasFiles(event: ReactDragEvent<HTMLElement>) {
    return event.dataTransfer.types.includes("Files");
  }

  const dropProps = {
    onDragEnter(event: ReactDragEvent<HTMLElement>) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragActive(true);
    },
    onDragLeave(event: ReactDragEvent<HTMLElement>) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (!dragDepthRef.current) setIsDragActive(false);
    },
    onDragOver(event: ReactDragEvent<HTMLElement>) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop(event: ReactDragEvent<HTMLElement>) {
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragActive(false);
      onFiles(event.dataTransfer.files);
    },
  };

  return { isDragActive, dropProps };
}
