import { describe, it, expect, vi } from "vitest";
import { registerSocketHandlers } from "../../socket/handlers.js";
import { Server, Socket } from "socket.io";
import { EventEmitter } from "events";

describe("Socket Handlers", () => {
  it("registers connection event on io server", () => {
    const io = new Server();
    const onSpy = vi.spyOn(io, "on");
    
    registerSocketHandlers(io);
    
    expect(onSpy).toHaveBeenCalledWith("connection", expect.any(Function));
  });

  it("handles client events internally on connection", () => {
    const io = new Server();
    let connectionHandler: Function | null = null;
    vi.spyOn(io, "on").mockImplementation((event, handler) => {
      if (event === "connection") {
        connectionHandler = handler as Function;
      }
      return io;
    });
    
    registerSocketHandlers(io);
    expect(connectionHandler).not.toBeNull();

    if (connectionHandler) {
      // Create a mock socket
      const mockSocket = new EventEmitter() as any;
      mockSocket.id = "mock-socket-id";
      mockSocket.join = vi.fn();
      mockSocket.leave = vi.fn();
      mockSocket.emit = vi.fn();
      mockSocket.on = vi.fn();
      mockSocket.handshake = {
        auth: {},
        headers: {},
        query: {},
        time: "",
        address: "",
        xdomain: false,
        secure: false,
        issued: 0,
        url: ""
      };

      // We expect the connection handler to register specific events on the socket
      (connectionHandler as Function)(mockSocket);

      expect(mockSocket.on).toHaveBeenCalledWith("join_board", expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith("leave_board", expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith("board_operation", expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith("cursor_moved", expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith("disconnect", expect.any(Function));
    }
  });
});
