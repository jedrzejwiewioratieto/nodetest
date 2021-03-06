const lobbyService = require('./modules/lobby/service');
const userService = require('./modules/user/service');
const appService = require('./modules/app/service');
const tools = require('./modules/tools');
const check = require('./modules/check');
const filter = require('./modules/filter');
const sapi = require('./sapi');
const SapiError = sapi.SapiError;
var debug = require('debug')('sapi:app');
debug.log = console.log.bind(console);

var apps = {};

const doAppUpdate = (db, lobbyId, ws) => {
  var _this = this;
  return appService.getMap(db, lobbyId)
    .then(appdataMap => {
      const sendUpdate = (client) => client.sendAction(
        "APP_UPDATE", appdataMap
      )
      if (ws)
        sendUpdate(ws);
      else
        sapi.getClients(filter.ws.byLobbyId(lobbyId)).forEach(sendUpdate)
    })
}

class AppContext {
  constructor(lock, ws, db, lobby, appdata) {
    this.ws = ws;
    this.db = db;
    this.currentUser = {
      _id: ws.store.currentUser._id,
      name: ws.store.currentUser.name
    };
    this.appdata = appdata;
    this.store = this.appdata.store;
    this.sapi = {
      me: ws,
      clients: undefined,
      lobbyMembers: undefined,
      lobbyObservers: undefined
    }
    this.lobby = lobby;
    this.isObserver = ws.store.isObserver === true;
  }

  _sapiFields() {
    if (this.sapi.clients === undefined) {
      this.sapi.clients = sapi.getClients(
        filter.ws.byLobbyId(this.lobby._id));
      this.sapi.lobbyMembers = this.sapi.clients.filter(
        ws => ws.isObserver !== true);
      this.sapi.lobbyObservers = this.sapi.clients.filter(
        ws => ws.isObserver === true);
    }
    return this.sapi;
  }

  forSapiClients(foo) {
    this._sapiFields().clients.forEach(foo);
  }

  forSapiLobbyMembers(foo) {
    this._sapiFields().lobbyMembers.forEach(foo);
  }

  forSapiLobbyObservers(foo) {
    this._sapiFields().lobbyObservers.forEach(foo);
  }

  terminate() {
    return appService.destroyAppdata(
      this.db,
      this.appdata.lobbyId,
      this.appdata.name
    );
  }

  doAppUpdate(ws) {
    return doAppUpdate(this.db, this.lobby._id, ws);
  }

  commit() {
    return appService.commitAppdata(this.db, this.appdata);
  }
}

const createAppContext = (ws, db, lobby, appName) => {
  console.log(apps, appName)
  return appService.getByLobbyIdAndName(db, lobby._id, appName)
    .then(appdata => {
      console.log("APPDATA", appdata)
      if (appdata === null) {
        appdata = {
          store: apps[appName].defaultStore,
          lobbyId: lobby._id,
          name: appName,
          exclusive: apps[appName].exclusive
        };
      }
      return new AppContext(null, ws, db, lobby, appdata)
    });
}


const app2sapi = (appPath) => {
  const manifest = require(appPath + '/manifest.json');
  const index = require(appPath + '/index');
  const app = {
    ...manifest,
    handlers: index.handlers
  }
  debug('registering %s', app.name)
  apps[app.name] = app;
  var sapiHandlers = {}
  Object.keys(app.handlers).forEach(type => {
    const appHandler = app.handlers[type];
    var ctx = new tools.Context();
    sapiHandlers[type] = (action, ws, db) => {
      console.log('sapihandler')
      return lobbyService.get.byIdWithMembers(db, ws.store.lobbyId)
        .then(ctx.store('lobby'))
        .then(() => createAppContext(ws, db, ctx.lobby, app.name))
        .then(ctx.store('appContext'))
        .catch(err => { })
        .then(appContext => appHandler(action, ctx.appContext))
    }
  });
  return sapiHandlers;
}

const preverify = {

  start: (db, lobby, appName) => {
    const app = apps[appName];
    // check members count
    if (lobby.members.length > app.usersLimit.max) {
      throw new Error('Too many lobby members!');
    }
    if (lobby.members.length < app.usersLimit.min) {
      throw new Error('Too few lobby members!');
    }
  },

  join: (db, lobby, appName) => {
    const app = apps[appName];
    if (app.hotJoin === false) {
      throw new Error('Unable to join during app operation');
    }
    // check members count
    if (lobby.members.length > app.usersLimit.max) {
      throw new Error('Lobby full!');
    }
  },

  leave: (db, lobby, appName) => {
    const app = apps[appName];
    if (app.hotLeave === false) {
      throw new Error('Unable to join during app operation');
    }
    // check members count
    if (lobby.members.length < app.usersLimit.min) {
      throw new Error('Too few lobby members!');
    }
  }
}

app2sapi.doAppUpdate = doAppUpdate;
app2sapi.createAppContext = createAppContext;
app2sapi.preverify = preverify

module.exports = app2sapi;
