import { ObjectId, type Collection, type Db } from 'mongodb';
import { COLLECTIONS, GENESIS, sealRecord, type AgentTraceDoc } from '@escrowops/shared';

/**
 * Appends one ticket's events to `agent_traces` under one `trace_id`, numbered by `seq` (A3).
 * Each event is hash-chained to the one before it (S9), so a later edit is detectable.
 */
export class TraceWriter {
  private seq = 0;
  private prevHash = GENESIS;
  private readonly traces: Collection<AgentTraceDoc>;

  constructor(
    db: Db,
    readonly traceId: string,
    readonly ticketId: string,
  ) {
    this.traces = db.collection<AgentTraceDoc>(COLLECTIONS.agent_traces);
  }

  async write(
    kind: AgentTraceDoc['kind'],
    fields: Pick<Partial<AgentTraceDoc>, 'tool' | 'input' | 'output' | 'text'> = {},
  ): Promise<void> {
    // Round-trip through BSON-safe values so the hash matches what is stored.
    const record: Omit<AgentTraceDoc, '_id' | 'created_at'> = JSON.parse(
      JSON.stringify({ trace_id: this.traceId, ticket_id: this.ticketId, seq: this.seq, kind, ...fields }),
    );
    const sealed = sealRecord(this.prevHash, { _id: new ObjectId(), ...record, created_at: new Date() });
    await this.traces.insertOne(sealed);
    this.seq += 1;
    this.prevHash = sealed.hash;
  }
}
