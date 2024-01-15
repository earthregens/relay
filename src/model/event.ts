type Event = {
  id: String;
  created_at: Number;
  pubkey: String;
  kind: Number;
  tags: String[][];
  content: String;
  sig: String;
};

export default Event;
