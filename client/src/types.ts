export interface Player {
  socketId: string;
  name: string;
  ready: boolean;
}

export interface ChatMsg {
  id: string;
  sender: string;
  text: string;
  ts: number;
}
