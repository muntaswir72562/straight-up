'use client';

import type { SlotData } from '@/lib/types';
import { Slot } from './Slot';

interface SlotGridProps {
  slots: SlotData[];
  locked: boolean;
  onFileDrop: (slotIndex: number, files: File[]) => void;
  onFileSelect: (slotIndex: number, file: File) => void;
  onClearSlot: (slotIndex: number) => void;
}

export function SlotGrid({
  slots,
  locked,
  onFileDrop,
  onFileSelect,
  onClearSlot,
}: SlotGridProps) {
  return (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
      }}
    >
      {slots.map((slot, index) => (
        <Slot
          key={slot.id}
          slot={slot}
          index={index}
          locked={locked}
          onFileDrop={onFileDrop}
          onFileSelect={onFileSelect}
          onClearSlot={onClearSlot}
        />
      ))}
    </div>
  );
}
