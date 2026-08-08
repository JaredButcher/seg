/**
 * @seg/server/realtime/connections — who is online, and how to reach them.
 *
 * One live socket per account (see the gateway), so this is a map from account to the thing
 * that can send it a message. It exists because two handlers now need the same answer: the
 * lobby has always needed to push a roster change to everyone in a lobby, and the match needs
 * to push a chat line to everyone who can hear it. Two registries with identical contents
 * would drift the first time one of them forgot a `detach`.
 *
 * Identity is supplied by whatever owns the socket. Nothing here derives it from a message —
 * a client that can name its own account id can act as anyone.
 */

import type { AccountId, ServerMessage } from '@seg/shared';

export interface PlayerConnection {
  readonly accountId: AccountId;
  readonly username: string;
  send(message: ServerMessage): void;
}

export class ConnectionRegistry {
  private readonly byAccount = new Map<AccountId, PlayerConnection>();

  /** Accounts currently connected, whether or not they are in a lobby or a match. */
  get size(): number {
    return this.byAccount.size;
  }

  add(connection: PlayerConnection): void {
    this.byAccount.set(connection.accountId, connection);
  }

  /**
   * Forget a connection.
   *
   * Takes the connection rather than only the id so a *replaced* socket cannot evict the one
   * that replaced it — the second tab has already registered under the same account by the
   * time the first one's close event lands.
   */
  remove(connection: PlayerConnection): void {
    if (this.byAccount.get(connection.accountId) === connection) {
      this.byAccount.delete(connection.accountId);
    }
  }

  /**
   * Forget whatever connection an account has, if any.
   *
   * For callers that only learned an account id — a handler's `detach`, which is told who
   * left rather than which socket did. Safe there because the gateway only reports a
   * detachment for the account's *current* socket.
   */
  removeById(accountId: AccountId): void {
    this.byAccount.delete(accountId);
  }

  get(accountId: AccountId): PlayerConnection | undefined {
    return this.byAccount.get(accountId);
  }

  /** Send to one account if it is connected. A no-op otherwise — that is not an error. */
  tell(accountId: AccountId, message: ServerMessage): void {
    this.byAccount.get(accountId)?.send(message);
  }
}
