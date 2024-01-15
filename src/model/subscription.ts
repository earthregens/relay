class Subscription {
  query: string;
  lastEvent: number;

  constructor(query?: string, lastEvent?: number) {
    this.query = query ?? '';
    this.lastEvent = lastEvent ?? 0;
  }
}

export default Subscription;
