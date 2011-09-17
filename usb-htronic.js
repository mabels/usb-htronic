/*
 * Used it as you want 
 * don't complain on me 
 * thx https://github.com/voodootikigod/node-serialport
 * This is used to control the conrad H-Tronics usb device
 * which has 8 Analog Input Ports and 
 * 8 Digital Output Ports
 * PCI Device ID 1f48:0628 
 * the Protocol description is written in 
 * http://www.produktinfo.conrad.com/datenblaetter/175000-199999/190760-an-01-de-USB_I_O_MODUL.pdf
 */
var util = require("util");
var sys = require("sys");
var serialport = require("serialport");
var SerialPort = serialport.SerialPort; // localize object constructor

var events = require('events');

var Queue = function () {
  this.queue = []
}
Queue.prototype.add = function(obj, wait_len, found_fn) {
  // obj should by { data: data, ofs: 0, len: len }
//console.log('ADD:'+JSON.stringify(obj))
  if (obj) {
    if (obj.length == 0) { return }
//    obj.offset = 0;
    this.queue.push({ data: obj, ofs: 0})
  }
  if (wait_len == 0) {
    found_fn(new Buffer(0), "")
    return
  }
  var segs = 0
  var need = wait_len
  for (var i = 0; i < this.queue.length; ++i) {
    var qe = this.queue[i];
    var diff = qe.data.length - qe.ofs;
    ++segs;
//console.log('PROC qlen='+qe.data.length+" qofs="+qe.ofs+" diff="+diff+" need="+need+":"+util.inspect(qe))
    if (diff >= need) {
      var buffer = new Buffer(wait_len)
      var buffer_ofs = 0
      for (var i = 0; i < segs-1; ++i) {
        /* all but last */
        qe = this.queue.shift()
        qe.data.copy(buffer, buffer_ofs, qe.ofs);
        buffer_ofs += qe.data.length - qe.ofs
//console.log('TOTAL');
        delete qe
      }
      qe = this.queue[0]
      qe.data.copy(buffer, buffer_ofs, qe.ofs, qe.ofs+need);
//console.log('PARTIAL', qe.data.length, qe.ofs, need, util.inspect(buffer), util.inspect(qe));
      if (qe.ofs+need == qe.data.length) {
//console.log('DELETE')
        delete this.queue.shift() 
      }
      else { this.queue[0].ofs += need }
      found_fn(buffer, qe['test'] && qe.test)
      break
    }
    need -= diff
  }
}

var HTronicMock = function() {
  events.EventEmitter.call(this);
}
HTronicMock.super_ = events.EventEmitter;
HTronicMock.prototype = Object.create(events.EventEmitter.prototype, { })
HTronicMock.prototype.write = function(data) {
    //console.log("HTronicMock:", data);
    if (data.length == 3) {
      var prefix = data.slice(0,2) 
      var cmd = parseInt(data.slice(2,3), 10); 
      if (prefix == "c0" && 1 <= cmd && cmd <= 8) {
        // ADChannel Command
        //console.log("ADChannel Respond:"+this.result);
        var buf = new Buffer(3);
        buf[0] = 0xca;
        buf[1] = 0xfe;
        buf[2] = (0xca + 0xfe) & 0xff;
        this.emit("data", buf);
        return
      } 
      if (prefix == 'c0' && cmd == '9') {
        var buf = new Buffer(17);
        var csum = 0;
        for(var i = 0; i < 16; i += 2) {
          buf[i] = 0xca;
          buf[i+1] = 0x80 | i
          csum += buf[i+0] + buf[i+1]
        }
        buf[16] = csum & 0xff
        this.emit("data", buf);
        return;
      }
    }
    if (data.length == 4) {
      var prefix = data.slice(0,2) 
      var cmd = parseInt(data.slice(2,3), 10); 
      var val = parseInt(data.slice(3,4), 10); 
      if (prefix == "c1" && 0 <= cmd && cmd <= 8) {
        this.emit("data", new Buffer("\r\nok\r\n"));
        return;
      }
    }
    if (data.length == 5) {
      var prefix = data.toString("utf8").slice(0,3) 
      if (prefix == "c19") {
        this.emit("data", new Buffer("\r\nok\r\n"));
      }
    }
}
  
var HTronic = function(opts) {
  opts = opts || {}
  this.logger = opts.logger || (function() {})
  this.port = opts.mock || new SerialPort(opts.port || '/dev/ttyACM0', {
    parser: serialport.parsers.raw,
    baudrate: 115200,
    databits: 8,
    stopbits: 1,
    parity: 0
  });
  this.queue = new Queue();
  var self = this;
  this.port.on("data", function(data) {
    self.logger('<<recv:'+util.inspect(data));
    self.wait && self.wait(data);
  })
  this.sendq = []
}

HTronic.prototype._cmd = function(nr, wait_len, complete) {
  if (nr instanceof Buffer) {
    var cmd = new Buffer(1 + nr.length)
    cmd[0] = "c".charCodeAt(0)
    nr.copy(cmd, 1)
  } else {
    var cmd = "c" + nr;
  }
  if (this.wait) {
    this.sendq.push(arguments);
    return;
  }
  this.wait = (function(wait_len, self) { 
    return function(data) { 
      self.queue.add(data, wait_len, function(buffer) { 
        self.wait = null; 
        complete(data);
        (self.sendq.length > 0) && self._cmd.apply(self, self.sendq.shift())
      })
    }
  })(wait_len, this);
  this.logger(">>cmd:",cmd);
  this.port.write(cmd);
}

HTronic.prototype.ADChannel = function(nr, complete) {
  if (1 <= nr && nr <= 8) {
    var cmd = ((100+nr)+"").slice(1);
    this._cmd(cmd, 3, function(data) {
      var value = data[0] << 8 | data[1];
      var csum = (data[0] + data[1]) & 0xff;
      if (csum != data[2]) { 
        complete("Checksum Error should be "+data[2].toString(16)+"!="+csum.toString(16));
      } else {
        complete(false, value);
      }
    });
    return;
  }
  throw new Error("ADChannel on 1 to 8 you used:"+nr);
}

HTronic.prototype.ADChannels = function(complete) {
    this._cmd("09", 17, function(data) {
      var values = [];
      var csum = 0;
      for (var i = 0; i < 16; i+=2) {
        values.push(data[i] << 8 | data[i+1]);
        csum += data[i+0] + data[i+1]
      }
      csum = csum & 0xff
      if (csum != data[16]) { 
        complete("Checksum Error should be "+data[16].toString(16)+"!="+csum.toString(16));
      } else {
        complete(false, values);
      }
    });
    return;
}
HTronic.prototype._docomplete = function(complete) {
  return function(data) {
      if (data.toString() == "\r\nok\r\n") {
        complete();
      } else {
        complete("Enable of the DOTimer failed with:"+data.toString());
      }
  }
}
HTronic.prototype._docmd = function(nr, onoff, complete) {
  var cmd = nr+(onoff?"1":"0")
  this._cmd(cmd, 6, this._docomplete(complete))
}

HTronic.prototype.DOTimer = function(onoff, complete) {
  this._docmd("10", onoff, complete)
}
HTronic.prototype.DOSet = function(port, onoff, complete) {
  if (1 <= port && port <= 8) {
    this._docmd("1"+port, onoff, complete)
    return;
  }
  throw new Error("DOSet on 1 to 8 you used:"+port);
}

HTronic.prototype.DOSets = function(onoffs, complete) {
  if (onoffs.length == 8) {
    var byte = 0
    for(var i = 0; i < 8; ++i) {
      byte |= (onoffs[i]?0:1) << i;
    }
    var buf = new Buffer(4);
    buf[0] = '1'.charCodeAt(0);
    buf[1] = '9'.charCodeAt(0);
    buf[2] = byte;
    buf[3] = ~byte;
    this._cmd(buf, 6, this._docomplete(complete))
    return;
  }
  throw new Error("DOSets onoffs has to have the length of 8:"+onoffs.length+":"+onoffs);
}
HTronic.test = function() {
  var htronic = new HTronic({
    mock: (new HTronicMock())  
  })
  for (var i = 1 ; i < 9; ++i) {
    htronic.ADChannel(i, function(err, value) {
      if (err) { 
        throw new Error("ADChannel:Error:"+err);
      }
      if (value != 0xcafe) {
        throw new Error("ADChannel:ValueError:"+value);
      }
      //console.log("AdChannel:", i, err, util.inspect(value));
    })
  }

  htronic.ADChannels(function(err, values) {
    if (err) { 
      throw new Error("ADChannels:Error:"+err);
    }
    for(var i = 0; i < 8; ++i) {
      if (values[i] != (0xca00 | (0x80|(i<<1)))) {
        throw new Error("ADChannels:ValueError:"+values[i]);
      }
    }
  })

  htronic.DOTimer(true, function(err) {
    if (err) { 
      throw new Error("DOTimer:Error:"+err);
    }
  })
  htronic.DOTimer(false, function(err) {
    if (err) { 
      throw new Error("DOTimer:Error:"+err);
    }
  })

  for (var i = 1 ; i < 9; ++i) {
    (function(i) { 
      htronic.DOSet(i, true, function(err, value) {
        if (err) { 
          throw new Error("DOSet:Error:"+err);
        }
      })
      htronic.DOSet(i, false, function(err, value) {
        if (err) { 
          throw new Error("DOSet:Error:"+err);
        }
      })
    })(i)
  }

  htronic.DOSets([1,0,1,0,1,0,1,0], function(err) {
    if (err) { 
      throw new Error("DOSets:Error:"+err);
    }
  })
}

HTronic.test()
