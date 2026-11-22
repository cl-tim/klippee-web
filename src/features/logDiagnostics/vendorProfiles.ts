import type { VendorProfile } from "./types";

type VendorSignature = {
  id: string;
  name: string;
  patterns: RegExp[];
};

const signatures: VendorSignature[] = [
  { id: "qidi", name: "QIDI", patterns: [/\bQIDI\b/i, /\bmcu_box\b/i, /\bToolChange\b/i, /qidi[-_ ]box/i] },
  { id: "beacon", name: "Beacon", patterns: [/\bbeacon(?:_coil|_model|_rev)?\b/i, /\[beacon\]/i] },
  { id: "cartographer", name: "Cartographer", patterns: [/\bcartographer\b/i, /\bscanner_touch\b/i] },
  { id: "klippain", name: "Klippain", patterns: [/\bklippain\b/i, /K-Shake&Tune/i, /Shake&Tune/i] },
  { id: "kamp", name: "KAMP", patterns: [/\bKAMP\b/i, /adaptive_mesh/i, /adaptive_purge/i] },
  { id: "ercf", name: "ERCF", patterns: [/\bERCF\b/i, /happy_hare/i, /mmu_machine/i] },
];

export class VendorProfileDetector {
  private evidence = new Map<string, Set<string>>();

  observe(line: string) {
    signatures.forEach((signature) => {
      if (!signature.patterns.some((pattern) => pattern.test(line))) return;
      const matches = this.evidence.get(signature.id) ?? new Set<string>();
      if (matches.size < 4) matches.add(line.replace(/\s+/g, " ").trim().slice(0, 180));
      this.evidence.set(signature.id, matches);
    });
  }

  finish(): VendorProfile[] {
    return signatures.flatMap((signature) => {
      const evidence = this.evidence.get(signature.id);
      return evidence?.size
        ? [{ evidence: [...evidence], id: signature.id, name: signature.name }]
        : [];
    });
  }
}
