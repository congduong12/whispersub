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
          <strong>Chọn video hoặc thả vào đây</strong>
          <small>Bạn có thể thêm nhiều file trong cùng một lần</small>
        </span>
        <span className="choose-chip">Chọn video</span>
    </button>
  );
}
