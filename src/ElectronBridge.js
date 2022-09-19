'use strict'
const { BrowserWindow } = require("electron")
const { ipcMain } = require('electron');
const debugFactory = require('debug');
const EventEmitter = require('events');
const debug = debugFactory('electron-webrtc-relay:Bridge')

const loadView = (preload, debug) => {
  return (`
   <!DOCTYPE html>
    <html>
      <head></head>
      <body>
      <p>WRTC Relay</p>
        <script>
          // region GLOBALS and INIT
          // maximum amount of open WebRTC handlers, after that queue
          const MAXMESSAGES = 475;
          
          // Counter for GC
          let i = 1;

          const queue = []
          const ipcRenderer = ${preload ? "window.ipcRenderer" : "require('electron').ipcRenderer"}           
          require = null;
          window.require = null;
          // endregion
          
          // region UTILS
          send = window.send = function (event, message) {
            ipcRenderer.send('WRTCRelayData', [ event, message ])
          }
          
          function handlersAtLimit(){
            return typeof conns === "object" && Object.keys(conns).length >= MAXMESSAGES
          }
          
          function workMessage(message){
             let err
             let res 
              try {
                res = eval(message.code)
              } catch (e) {
                err = e.message
                ${debug ? 'console.error(e)' : ""}
              }
              window.send(message.id, { res: res, err: err })
          }
          
          function invokeGC(){
            console.log(i++);
           
            if (!(i % 5)) {
              // try to invoke GC on each 5ish iteration
              // https://bugs.chromium.org/p/chromium/issues/detail?id=825576 Garbage Collection not deleting closed WebRTC messages
              queueMicrotask(() => { 
                if(typeof conns === "object"){
                  ${debug ? 'console.log("gcing all conns: " + Object.keys(conns).length)' : ""}
                  Object.keys(conns).forEach((id) => {
                    let tmpPC = conns[id]
                    if(tmpPC?.signalingState === "closed"){
                      tmpPC = null;
                      conns[id] = null;
                      delete conns[id];
                    }
                  })
                }
                let img = document.createElement("img");
                img.src = window.URL.createObjectURL(new Blob([new ArrayBuffer(5e+7)])); // 50Mo or less or more depending as you wish to force/invoke GC cycle run
                img.onerror = function() {
                  window.URL.revokeObjectURL(this.src);
                  img = null
                }
              })
            }
          }
          // endregion
          
          ${debug ? 'console.log("initializing browser " + typeof ipcRenderer)' : ""}

          // region MAIN LOGIC
          function workQueue(){
            if(queue.length === 0) return;
            if(handlersAtLimit()) return;
            queueMicrotask(() => {
              let message = queue.shift()
              workMessage(message)
            })
          }
          setInterval(workQueue, 50);
        
          ipcRenderer.on('WRTCRelayData', function (e, message) {  
            if(handlersAtLimit()) {
              queue.push(message)
              return;
            }
            workMessage(message)
          })
          // endregion
        </script>
      </body>
    </html>
  `)
}

module.exports = class Bridge extends EventEmitter {
  BrowserWindow = null;
  i = 0
  queue = []
  ready = false
  closing = false

  opts = {}
  constructor (opts) {
    super()
    if(typeof opts === "undefined") opts = {debug: false}
    this.opts = opts;
    if(opts.debug) debug.enabled = true;
  }

  _debug(msg){
    if(!this.opts.debug) return;
    debug(msg)
  }

  init(){
    this._debug(`Initializing Relay: ${JSON.stringify(this.opts)}`)

    this.BrowserWindow = new BrowserWindow({
      title: 'WRTC Relay',
      width: this.opts.debug ? 900 : 0,
      height: this.opts.debug ? 750 : 0,
      transparent: !this.opts.debug,
      frame: this.opts.debug,
      alwaysOnTop: false,
      skipTaskbar: true,
      center: true,
      show: true,
      webPreferences: {
        nodeIntegration: typeof this.opts.preload === "string" ? false : true,
        contextIsolation: typeof this.opts.preload === "string" ? true : false,
        webSecurity: true,
        preload: typeof this.opts.preload === "string" ? this.opts.preload : "",
        devTools: this.opts.debug ? true : false,
      },
    });

    if(this.opts.debug) this.BrowserWindow.webContents.openDevTools();
    var file = 'data:text/html;charset=UTF-8,' + encodeURIComponent(loadView(typeof this.opts.preload === "string", this.opts.debug));
    this.BrowserWindow.loadURL(
      file
    );

    this.BrowserWindow.once('ready-to-show', () => {
      this.ready = true;
      ipcMain.on("WRTCRelayData", (event, message) => {
        if (typeof message !== 'object') return
        debug(`Received: ${JSON.stringify(message)}`)
        this.emit(message[0], message[1])
      })
      this._queue()
    });
  }

  _queue(){
    this.queue.forEach((obj) => {
      this.BrowserWindow.webContents.send("WRTCRelayData", obj)
    })
  }

  eval(code, opts = {}, cb){
    const inactive = this.BrowserWindow === null || !this.ready

    if (typeof opts === 'function') {
      cb = opts
      opts = {}
    }
    this._debug(`opts: ${JSON.stringify(opts)} eval: ${JSON.stringify(code)}, BrowserWindow active: ${!inactive}`)

    const id = (this.i++).toString(36)

    this.once(id, (res) => {
      let err = null
      if (res.err) {
        const target = opts.mainProcess ? 'main process' : 'window'
        err = new Error(
          `Error evaluating "${code}" ` + `in "${target}": ${res.err}`
        )
        err.original = res.err
      }
      if (cb) {
        if (err) return cb(err)
        return cb(null, res.res)
      }
      if (err) console.error(err)//this.emit('error', err)
    })

    if(inactive){
      this.queue.push({id, code})
      return;
    }

    this.BrowserWindow.webContents.send("WRTCRelayData", { id, code })
  }

  close(){

  }
}