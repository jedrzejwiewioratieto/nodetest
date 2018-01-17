const WebSocket = require('ws');
const OID = require('./object-id');

var debug = {
  connection: require('debug')('sapi:connection'),
  data: require('debug')('sapi:data'),
  handlers: require('debug')('sapi:handlers'),
  test: require('debug')('sapi:test'),
  actions: require('debug')('sapi:actions')
}
Object.values(debug).forEach((v) => {
  v.log = console.log.bind(console);
});


var server = null;


class SapiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code
  }

  toPayload() {
    return {
      code: this.code,
      message: this.message
    }
  }

  static from(e, code) {
    return new SapiError(e.message, code);
  }
}


function combineHandlers(...handlers) {
  var resultHandlers = {};
  for (var handler of handlers) {
    resultHandlers = {
      ...resultHandlers,
      ...handler
    };
  }
  return resultHandlers;
}


function sendAction(param1, param2) {
  var action;
  if (typeof param1 === 'string') {
    action = {
      type: param1,
      payload: param2
    }
  } else {
    action = param1;
  }
  if (action.type === undefined) {
    throw new SapiError("No action type", "EINVACTION");
  }
  try {
    const message = JSON.stringify(action, null, 2);
    this.debug.actions("=> " + action.type);//.substring(0, 100), message.length > 100 ? "..." : "");
    this.debug.data("=> " + message);//.substring(0, 100), message.length > 100 ? "..." : "");
    return this.send(message);
  } catch (e) {
    throw SapiError.from(e, "EPARSEERROR");
  }
}

function onConnection(handlers, db) {
  return (ws, req) => {
    ws.debug = {};
    Object.keys(debug).forEach(key => {
      ws.debug[key] = (...args) => debug[key]('[ws:%d] ' + args[0], OID(ws), ...args.slice(1));
    })
    ws.debug.connection("connection initiated " + OID(ws));
    ws.isAlive = true;
    ws.store = {};
    ws.sendAction = sendAction.bind(ws);

    ws.on('pong', function () {
      ws.isAlive = true;
    });

    ws.on('message', function (message) {
      ws.debug.data("<= " + message);//.substring(0, 100), message.length > 100 ? "..." : "");
      var action = null;
      try {
        action = JSON.parse(message);
      } catch (e) {
        ws.debug.data(SapiError.from(e, "EPARSEERROR"));
      }
      try {
        if (action.type === undefined) {
          ws.debug.data("Malformed action! No action type!");
        } else if (handlers[action.type] !== undefined) {
          ws.debug.actions("<= %s", action.type);
          ws.debug.handlers("Action handler for [%s] present", action.type);
          Promise.resolve(handlers[action.type](action, ws, db))
            .catch(err => {
              ws.debug.handlers(err.stack);
            })
        } else {
          ws.debug.handlers("No action handler for [%s]", action.type);
        }
      } catch (e) {
        throw e;
      }
    });

    ws.on('open', function () {
      ws.debug.connection("connection opened");
    });

    ws.on('close', function (code, reason) {
      ws.debug.connection("connection closed, code: %s reason: %s", code, reason);
    });

    ws.on('error', function (err) {
      ws.debug.connection("connection error: %s", err);
    })
  }
}


const start = (port, handlers, db) => {
  if (server === null) {
    new Promise((resolve, reject) => {
      server = new WebSocket.Server({ port });
      server.on('connection', onConnection(handlers, db));
      server.on('open', resolve);
      server.on('error', reject);

      Object.keys(handlers).forEach(type => debug.handlers("Registering handler: " + type))


      // heart beat
      if (server.heartBeatInterval == undefined) {
        server.heartBeatInterval = setInterval(function ping() {
          for (var ws of server.clients) {
            if (ws.isAlive) {
              ws.ping('', false, true);
              ws.isAlive = false;
            }
            else {
              ws.debug.connection('Dead connection terminating');
              ws.terminate();
            }
          }
        }, 5000);
      }
    });
  }
}

const stop = (cb) => {
  if (server !== null) {
    server.close(cb)
  }
}

const withWS = (addr, promiseCreator) => {
  return new Promise((resolve, reject) => {
    var ws = new WebSocket(addr);
    ws.buffer = [];
    ws.once('open', (event) => {
      promiseCreator(ws)
        .then(resolve)
        .catch(reject)
        .then(() => {
          ws.close();
        })
    });
    ws.once('error', reject);
    ws.on('message', message => {
      ws.buffer.push(message);
    });
  });
}

const getClients = filter => {
  var members = Array.from(server.clients);
  if (filter)
    members = members.filter(filter);
  return members;
}


const test = {
  waitForAction: (ws, expected) => () => {
    return new Promise((resolve, reject) => {
      ws.debug.test("waiting for action %s", expected);
      const trigger = () => {
        const action = JSON.parse(ws.buffer.pop());
        if (expected) {
          if (action.type == expected) {
            resolve(action);
          } else {
            ws.debug.test("Unexpected action %s", action.type);
            const err = new SapiError(
              "Incorrect action: " + action.type + " instead of " + expected + ")",
              "EUNEXPECTEDACTION");
            reject(err);
          }
        } else {
          resolve(action);
        }
      };
      if (ws.buffer.length > 0) {
        trigger();
      } else {
        ws.once('message', event => {
          trigger();
        });
      }
    });
  },


  sendAction: (ws, param1, param2) => () => {
    var action;
    if (typeof param1 === 'string') {
      action = {
        type: param1,
        payload: param2
      }
    } else if (typeof action === 'function') {
      action = param1();
    } else {
      action = param1;
    }
    return new Promise((resolve, reject) => {
      ws.debug.test("Sending action %s", action.type);
      ws.send(JSON.stringify(action, null, 2));
      resolve();
    })
  }
}


module.exports = {
  start,
  stop,
  combineHandlers,
  SapiError,
  withWS,
  getClients,
  test
}
