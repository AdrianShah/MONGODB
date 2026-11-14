import { ObjectId, type Collection, type Db } from 'mongodb';
import { COLLECTIONS, type AgentTraceDoc } from '@escrowops/shared';

/** Appends one ticket's events to `agent_traces` under one `trace_id`, numbered by `seq` (A3). */
export class TraceWriter {
  private seq = 0;
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
    await this.traces.insertOne({
      _id: new ObjectId(),
      trace_id: this.traceId,
      ticket_id: this.ticketId,
      seq: this.seq++,
      kind,
      ...fields,
      created_at: new Date(),
    });
  }
}
