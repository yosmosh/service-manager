// Ports 80 and 443 of the router in front of this computer, opened to it through UPnP — and kept
// open: a router forgets such openings when it restarts (a power cut), so selfhost/windows-service.js
// checks them every ten minutes and opens them again when missing. (At home: the TP-Link behind
// the provider's box; the provider's box itself has its own, saved, rule.)
//
// An opening pointing at another device is left alone — unless it is one of ours (named
// «SadBudushego …») left pointing at an address this computer no longer has.

'use strict';

const dgram = require('dgram');
const http = require('http');
const os = require('os');

const PREFIX = 'SadBudushego';

// This computer's addresses on a home network (not the VPN's, not loopback), the cable first.
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && /^(192\.168\.|10\.)/.test(a.address)) out.push({ address: a.address, wired: /ethernet|eth|lan/i.test(name) });
    }
  }
  return out.sort((x, y) => (y.wired ? 1 : 0) - (x.wired ? 1 : 0)).map(a => a.address);
}

function request(url, { method, headers, body, localAddress }) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method: method || 'GET', headers, localAddress, timeout: 5000 }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// The routers answering a UPnP search from this address → [description URL].
function discover(localAddress) {
  return new Promise(resolve => {
    const found = new Set();
    const sock = dgram.createSocket('udp4');
    const done = () => { try { sock.close(); } catch (e) {} resolve(Array.from(found)); };
    sock.on('error', done);
    sock.on('message', m => { const loc = /^location:\s*(\S+)/im.exec(m.toString()); if (loc) found.add(loc[1]); });
    sock.bind({ address: localAddress, port: 0 }, () => {
      const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n');
      sock.send(msg, 1900, '239.255.255.250', err => { if (err) done(); });
      setTimeout(done, 3000);
    });
  });
}

// The router's port-mapping service: {control, type}, or null.
async function service(location, localAddress) {
  const r = await request(location, { localAddress });
  for (const block of r.text.split(/<service>/i).slice(1)) {
    const type = /<serviceType>\s*([^<]*WAN(?:IP|PPP)Connection:\d)\s*</i.exec(block);
    const ctl = /<controlURL>\s*([^<]*)\s*</i.exec(block);
    if (type && ctl) return { control: new URL(ctl[1], location).toString(), type: type[1] };
  }
  return null;
}

async function soap(svc, localAddress, action, args) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.type}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const r = await request(svc.control, { method: 'POST', localAddress, body, headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.type}#${action}"`, 'Content-Length': Buffer.byteLength(body) } });
  const tag = name => { const m = new RegExp(`<${name}>([^<]*)<`).exec(r.text); return m ? m[1] : null; };
  return { ok: r.status === 200, tag, error: tag('errorCode') };
}

// Checks each port once; returns what it did, one line each (nothing when all was in order).
async function ensurePorts(ports) {
  const mine = lanAddresses();
  const said = [];
  for (const local of mine) {
    let svc = null;
    for (const loc of await discover(local)) { try { svc = await service(loc, local); } catch (e) {} if (svc) break; }
    if (!svc) continue;
    const router = new URL(svc.control).hostname;
    for (const port of ports) {
      const key = { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' };
      const cur = await soap(svc, local, 'GetSpecificPortMappingEntry', key);
      const client = cur.ok ? cur.tag('NewInternalClient') : null;
      if (client && mine.includes(client) && cur.tag('NewEnabled') !== '0') continue;
      if (client && !String(cur.tag('NewPortMappingDescription') || '').startsWith(PREFIX)) { said.push(`port ${port} on ${router} is opened to another device (${client}) — left as it is`); continue; }
      if (client) await soap(svc, local, 'DeletePortMapping', key);
      const add = await soap(svc, local, 'AddPortMapping', Object.assign({}, key, { NewInternalPort: port, NewInternalClient: local, NewEnabled: 1, NewPortMappingDescription: `${PREFIX} ${port}`, NewLeaseDuration: 0 }));
      said.push(add.ok ? `port ${port} on ${router} opened to ${local}` : `port ${port} on ${router} could not be opened (error ${add.error})`);
    }
    return said; // one router is enough: the one the cable (or else the Wi-Fi) leads to
  }
  return said;
}

module.exports = { ensurePorts, lanAddresses };
