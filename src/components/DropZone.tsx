interface DropZoneProps {
  onChoose: () => void;
  disabled: boolean;
}

export function DropZone({ onChoose, disabled }: DropZoneProps) {
  return (
    <button
      className="drop-zone"
      type="button"
      onClick={onChoose}
      disabled={disabled}
    >
          <span className="drop-icon" aria-hidden="true">
            ↓
          </span>
          <span>
            <strong>Thêm video hoặc audio</strong>
            <small>Chọn nhiều file hoặc kéo thả vào đây</small>
          </span>
          <span className="choose-chip">Chọn file</span>
      </button>
  );
}
