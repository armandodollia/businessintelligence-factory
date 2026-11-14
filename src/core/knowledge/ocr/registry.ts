/**
 * Where the extraction pipeline hands artifacts that need OCR pass 2. One sink per `ArtifactStore`
 * (the runtime's `OcrQueue`); none registered means OCR is unavailable and nothing is planned.
 * Its own module so `ingest.ts` and `ocr/worker.ts` do not import each other in a cycle.
 */
import type { ArtifactStore } from '../../evidence/artifacts.js';

export interface OcrSink {
  /** Queues an artifact whose `ocr_status` is `pending`. */
  enqueue(artifactId: string): void;
  /**
   * Resolves once the artifact's OCR is no longer waiting: runs it now when it is `pending` (joining
   * a run in flight). Used where a caller needs the transcription at once (quote checks). Never rejects.
   */
  ensure(artifactId: string): Promise<void>;
}

const sinks = new WeakMap<ArtifactStore, OcrSink>();

export function registerOcr(artifacts: ArtifactStore, sink: OcrSink): void {
  sinks.set(artifacts, sink);
}

export function unregisterOcr(artifacts: ArtifactStore, sink: OcrSink): void {
  if (sinks.get(artifacts) === sink) sinks.delete(artifacts);
}

export function ocrSinkFor(artifacts: ArtifactStore): OcrSink | undefined {
  return sinks.get(artifacts);
}
