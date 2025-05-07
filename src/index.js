/* eslint-disable complexity */
import { simpleMetrics } from '@libp2p/simple-metrics'
import { protocols } from '@multiformats/multiaddr'
import { WebRTC, WebRTCDirect, WebSockets, WebSocketsSecure, WebTransport, Circuit } from '@multiformats/multiaddr-matcher'
import { Chart, LineController, CategoryScale, LinearScale, PointElement, LineElement, TimeScale, Legend } from 'chart.js'
import { createHelia, libp2pDefaults } from 'helia'
import { sha256 } from 'multiformats/hashes/sha2'
import prettyMs from 'pretty-ms'
import 'chartjs-adapter-date-fns'
import * as Utils from './utils.js'
import { webTransport } from '@libp2p/webtransport'

// peer ids of known bootstrap nodes
const bootstrapPeers = [
  'QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  'QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  'QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  'QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  'QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
  'QmZa1sAxajnQjVM8WjWXoMbmPd7NsWhfKsPkErzpm9wGkp'
]

const pings = {}
let queryController = new AbortController()

const App = async () => {
  const DOM = {
    nodePeerId: () => document.getElementById('output-node-peer-id'),
    nodeStatus: () => document.getElementById('output-node-status'),
    nodePeerCount: () => document.getElementById('output-peer-count'),
    nodePeerTypes: () => document.getElementById('output-peer-types'),
    nodePeerDetails: () => document.getElementById('output-peer-details'),
    nodeAddressCount: () => document.getElementById('output-address-count'),
    nodeAddresses: () => document.getElementById('output-addresses'),

    queryButton: () => document.getElementById('button-run-query'),
    outputQuery: () => document.getElementById('output-query'),

    webTransportConnectionsPerMinute: () => document.getElementById('output-webtransport-opened-per-minute'),
    webTransportConnectionsPerUnit: () => document.getElementById('output-webtransport-opened-per-unit'),
    webTransportConnectionsSuccess: () => document.getElementById('output-webtransport-success'),
    webTransportConnectionsReadyError: () => document.getElementById('output-webtransport-ready-error'),
    webTransportConnectionsNoiseError: () => document.getElementById('output-webtransport-noise-error'),
    webTransportConnectionsUpgradeError: () => document.getElementById('output-webtransport-upgrade-error'),
    webTransportConnectionsReadyTimeout: () => document.getElementById('output-webtransport-ready-timeout'),
    webTransportConnectionsNoiseTimeout: () => document.getElementById('output-webtransport-noise-timeout'),
    webTransportMaxConnectionsPerMinute: () => document.getElementById('output-webtransport-max-opened-per-minute'),
    webTransportConnectionsFailureRate: () => document.getElementById('output-webtransport-failure-rate'),

    webTransportStatsGraph: () => document.getElementById('webtransport-stats')
  }

  const totals = {
    readyErrored: 0,
    noiseErrored: 0,
    upgradeErrored: 0,
    readyTimedout: 0,
    noiseTimedout: 0,
    success: 0
  }

  const stats = {
    pending: 0,
    open: 0,

    ready_error: 0,
    noise_error: 0,
    upgrade_error: 0,

    ready_timeout: 0,
    noise_timeout: 0,

    close: 0,
    abort: 0,
    remote_close: 0
  }

  let lastStats = {
    pending: 0,
    ready_error: 0,
    noise_error: 0,
    upgrade_error: 0,
    close: 0,
    remote_close: 0,
    ready: 0,
    abort: 0,
    ready_timeout: 0,
    noise_timeout: 0,
    open: 0
  }

  const chartColours = {
    // state of connections
    open: Utils.CHART_COLORS.green,
    pending: Utils.CHART_COLORS.yellow,

    // errors opening connections
    ready_error: Utils.CHART_COLORS.red,
    noise_error: 'rgb(193, 69, 95)',
    upgrade_error: 'rgb(149, 45, 67)',

    ready_timeout: Utils.CHART_COLORS.orange,
    noise_timeout: 'rgb(167, 103, 40)',

    // how connections close
    close: Utils.CHART_COLORS.blue,
    abort: 'rgb(43, 129, 187)',
    remote_close: 'rgb(30, 100, 147)'
  }

  const maxPoints = 3 * 60
  const now = Date.now()

  Chart.register(LineController, CategoryScale, LinearScale, PointElement, LineElement, TimeScale, Legend)
  const chart = new Chart(DOM.webTransportStatsGraph(), {
    type: 'line',
    data: {
      labels: [now],
      datasets: Object.keys(stats).map((name) => {
        return {
          label: name,
          data: [{ x: now, y: 0 }],
          borderColor: chartColours[name],
          backgroundColor: Utils.transparentize(chartColours[name], 0.5)
        }
      })
    },
    options: {
      animation: false,
      legend: {
        display: true,
        title: {
          display: true,
          text: 'Legend Title'
        },
        position: 'top',
        labels: {
          color: 'rgb(255, 99, 132)'
        }
      },
      plugins: {
        legend: {
          display: true
        }
      },
      scales: {
        x: {
          type: 'time',
          suggestedMax: now + (maxPoints * 1000)
        },
        y: {
          min: 0,
          suggestedMax: 30
        }
      }
    }
  })

  let openSessionEvents = []
  let maxOpenSessionsPerMinute = 0

  const libp2p = libp2pDefaults()
  libp2p.metrics = simpleMetrics({
    onMetrics: (metrics) => {
      try {
        const webTransportEvents = metrics.libp2p_webtransport_dialer_events_total
        const now = new Date()

        chart.data.labels.push(now.getTime())

        const newPending = (webTransportEvents.pending ?? 0) - (lastStats.pending ?? 0)
        const newReadyError = (webTransportEvents.ready_error ?? 0) - (lastStats.ready_error ?? 0)
        const newNoiseError = (webTransportEvents.noise_error ?? 0) - (lastStats.noise_error ?? 0)
        const newUpgradeError = (webTransportEvents.upgrade_error ?? 0) - (lastStats.upgrade_error ?? 0)
        const newClose = (webTransportEvents.close ?? 0) - (lastStats.close ?? 0)
        const newReady = (webTransportEvents.ready ?? 0) - (lastStats.ready ?? 0)
        const newAbort = (webTransportEvents.abort ?? 0) - (lastStats.abort ?? 0)
        const newReadyTimeout = (webTransportEvents.ready_timeout ?? 0) - (lastStats.ready_timeout ?? 0)
        const newNoiseTimeout = (webTransportEvents.noise_timeout ?? 0) - (lastStats.noise_timeout ?? 0)
        const newOpen = (webTransportEvents.open ?? 0) - (lastStats.open ?? 0)
        const newRemoteClose = (webTransportEvents.remote_close ?? 0) - (lastStats.remote_close ?? 0)

        stats.pending += newPending
        stats.pending -= newReadyTimeout
        stats.pending -= newNoiseTimeout
        stats.pending -= newReadyError
        stats.pending -= newNoiseError
        stats.pending -= newUpgradeError
        stats.pending -= newOpen

        stats.open += newOpen
        stats.open -= newClose
        stats.open -= newRemoteClose
        stats.open -= newAbort

        // non-cumlative
        stats.ready_error = newReadyError
        stats.noise_error = newNoiseError
        stats.upgrade_error = newUpgradeError
        stats.ready_timeout = newReadyTimeout
        stats.noise_timeout = newNoiseTimeout
        stats.close = newClose
        stats.abort = newAbort
        stats.remote_close = newRemoteClose

        totals.success += newReady
        totals.readyErrored += newReadyError
        totals.noiseErrored += newNoiseError
        totals.upgradeErrored += newUpgradeError
        totals.readyTimedout += newReadyTimeout
        totals.noiseTimedout += newNoiseTimeout

        DOM.webTransportConnectionsSuccess().innerHTML = totals.success
        DOM.webTransportConnectionsReadyError().innerHTML = totals.readyErrored
        DOM.webTransportConnectionsNoiseError().innerHTML = totals.noiseErrored
        DOM.webTransportConnectionsUpgradeError().innerHTML = totals.upgradeErrored
        DOM.webTransportConnectionsReadyTimeout().innerHTML = totals.readyTimedout
        DOM.webTransportConnectionsNoiseTimeout().innerHTML = totals.noiseTimedout

        // work out connections in the last minute
        openSessionEvents.push(newPending)
        if (openSessionEvents.length > 60) {
          DOM.webTransportConnectionsPerUnit().innerText = 'minute'
          openSessionEvents = openSessionEvents.slice(openSessionEvents.length - 60)
        } else {
          DOM.webTransportConnectionsPerUnit().innerText = `${openSessionEvents.length} seconds`
        }
        const openSessionEventCount = openSessionEvents.reduce((acc, curr) => acc + curr, 0)
        DOM.webTransportConnectionsPerMinute().innerText = openSessionEventCount

        // calculate max sessions opened per minute
        if (openSessionEventCount > maxOpenSessionsPerMinute) {
          maxOpenSessionsPerMinute = openSessionEventCount
        }
        DOM.webTransportMaxConnectionsPerMinute().innerText = maxOpenSessionsPerMinute

        // calculate failure rate
        const errors = totals.readyErrored + totals.noiseErrored + totals.upgradeErrored
        const timeouts = totals.readyTimedout + totals.noiseTimedout
        const failureRate = ((errors + timeouts) / (errors + timeouts + totals.success) * 100).toFixed(2)
        DOM.webTransportConnectionsFailureRate().innerText = `${failureRate}%`

        Object.keys(stats).forEach((name, index) => {
          chart.data.datasets[index].data.push({
            x: now.getTime(),
            y: stats[name]
          })

          if (chart.data.datasets[index].data.length > maxPoints) {
            chart.data.datasets[index].data = chart.data.datasets[index].data.slice(-maxPoints)
          }
        })

        if (chart.data.labels.length > maxPoints) {
          chart.data.labels = chart.data.labels.slice(-maxPoints)
        }

        chart.update()
        lastStats = webTransportEvents
      } catch (err) {
        console.error(err)
      }
    }
  })
  libp2p.transports.push(
    webTransport()
  )
  libp2p.connectionMonitor = {
    enabled: false
  }

  const helia = await createHelia({
    start: false,
    libp2p
  })

  update(DOM.nodePeerId(), helia.libp2p.peerId.toString())
  update(DOM.nodeStatus(), 'Starting')

  await helia.start()

  helia.libp2p.addEventListener('peer:connect', (event) => {
    const ping = {
      latency: -1,
      lastPing: 0,
      controller: new AbortController(),
      interval: setInterval(async () => {
        try {
          ping.latency = await helia.libp2p.services.ping.ping(event.detail, {
            signal: ping.controller.signal
          })
          ping.lastPing = Date.now()
        } catch (err) {
          console.error('error while running ping', err)
        }
      }, 5000)
    }

    pings[event.detail.toString()] = ping
  })
  helia.libp2p.addEventListener('peer:disconnect', (event) => {
    const ping = pings[event.detail.toString()]

    if (ping == null) {
      return
    }

    ping.controller.abort()
    clearInterval(ping.interval)
  })

  DOM.nodeStatus().innerText = 'Online'

  setInterval(() => {
    update(DOM.nodePeerCount(), helia.libp2p.getConnections().length)
    update(DOM.nodePeerTypes(), getPeerTypes(helia))
    update(DOM.nodeAddressCount(), helia.libp2p.getMultiaddrs().length)
    update(DOM.nodeAddresses(), getAddresses(helia))
    update(DOM.nodePeerDetails(), getPeerDetails(helia))
  }, 1000)

  DOM.queryButton().onclick = async (e) => {
    e.preventDefault()

    update(DOM.outputQuery(), '')

    queryController.abort()
    queryController = new AbortController()
    const buf = new TextEncoder().encode(Math.random().toString())
    const digest = await sha256.encode(buf)
    const queryResults = {}

    try {
      for await (const event of helia.libp2p.services.dht.getClosestPeers(digest, {
        signal: queryController.signal
      })) {
        if (event.name === 'DIAL_PEER') {
          queryResults[event.peer.toString()] = queryResults[event.peer.toString()] ?? []
          queryResults[event.peer.toString()].push(`  ${event.name}`)
        }

        if (event.name === 'SEND_QUERY') {
          queryResults[event.to.toString()] = queryResults[event.to.toString()] ?? []
          queryResults[event.to.toString()].push(`  ${event.name} ${event.messageName}`)
        }

        if (event.name === 'QUERY_ERROR') {
          queryResults[event.from.toString()] = queryResults[event.from.toString()] ?? []
          queryResults[event.from.toString()].push(`  ${event.name} ${event.error.message}`)
        }

        if (event.name === 'PEER_RESPONSE') {
          queryResults[event.from.toString()] = queryResults[event.from.toString()] ?? []

          queryResults[event.from.toString()].push(`  ${event.name} ${event.messageName}`)
          queryResults[event.from.toString()].push('  Closer peers:')

          event.closer.forEach(closer => {
            queryResults[event.from.toString()].push(`    ${closer.id.toString()}`)

            closer.multiaddrs.forEach((ma) => {
              queryResults[event.from.toString()].push(`      ${ma.toString()}`)
            })
          })
        }

        if (event.name === 'FINAL_PEER') {
          queryResults[event.from.toString()] = queryResults[event.from.toString()] ?? []
          queryResults[event.from.toString()].push(`  ${event.name} ${event.peer.id.toString()}`)

          event.peer.multiaddrs.forEach((ma) => {
            queryResults[event.from.toString()].push(`    ${ma.toString()}`)
          })
        }

        update(DOM.outputQuery(), Object.entries(queryResults).map(([name, events]) => (`${name}\n${events.join('\n')}`)).join('\n\n'))
      }
    } catch (err) {
      console.error('query error', err)
    }
  }
}

App().catch(err => {
  console.error(err) // eslint-disable-line no-console
})

function getAddresses (helia) {
  return helia.libp2p.getMultiaddrs()
    .map(ma => `<li>${ma.toString()} <button onclick="navigator.clipboard.writeText('${ma.toString()}')">Copy</button></li>`)
    .join('')
}

function getPeerTypes (helia) {
  const types = {
    'Circuit Relay': 0,
    WebRTC: 0,
    'WebRTC Direct': 0,
    WebSockets: 0,
    'WebSockets (secure)': 0,
    WebTransport: 0,
    Other: 0
  }

  helia.libp2p.getConnections().map(conn => conn.remoteAddr).forEach(ma => {
    if (WebRTC.exactMatch(ma) || ma.toString().includes('/webrtc/')) {
      types.WebRTC++
    } else if (WebRTCDirect.exactMatch(ma)) {
      types['WebRTC Direct']++
    } else if (WebSockets.exactMatch(ma)) {
      types.WebSockets++
    } else if (WebSocketsSecure.exactMatch(ma)) {
      types['WebSockets (secure)']++
    } else if (WebTransport.exactMatch(ma)) {
      types.WebTransport++
    } else if (Circuit.exactMatch(ma)) {
      types['Circuit Relay']++
    } else {
      types.Other++
      console.info('wat', ma.toString())
    }
  })

  return Object.entries(types)
    .map(([name, count]) => `<li>${name}: ${count}</li>`)
    .join('')
}

function getPeerDetails (helia) {
  return helia.libp2p.getPeers().map(peer => {
    const ping = pings[peer.toString()]
    let pingOutput = 'Ping RTT: ...measuring<br/>Last measured: 0s ago'

    if (ping != null && ping.latency > -1) {
      pingOutput = `Ping RTT: ${ping.latency}ms<br/>Last measured: ${Math.round((Date.now() - ping.lastPing) / 1000)}s ago`
    }

    const peerConnections = helia.libp2p.getConnections(peer)

    pingOutput += `<br>Connection age: ${prettyMs(Date.now() - peerConnections[0].timeline.open)}`

    const nodeType = []

    // detect if this is a bootstrap node
    if (bootstrapPeers.includes(peer.toString())) {
      nodeType.push('bootstrap')
    }

    const relayMultiaddrs = helia.libp2p.getMultiaddrs().filter(ma => Circuit.exactMatch(ma))
    const relayPeers = relayMultiaddrs.map(ma => {
      return ma.stringTuples()
        .filter(([name, _]) => name === protocols('p2p').code)
        .map(([_, value]) => value)[0]
    })

    // detect if this is a relay we have a reservation on
    if (relayPeers.includes(peer.toString())) {
      nodeType.push('relay')
    }

    return `<li>
      <h4>${peer.toString()} <button onclick="navigator.clipboard.writeText('${peer.toString()}')">Copy</button> ${nodeType.length > 0 ? `(${nodeType.join(', ')})` : ''}</h4>
      <p>${pingOutput}</p>
      <ul>${
        peerConnections.map(conn => {
          return `<li>${conn.remoteAddr.toString()} <button onclick="navigator.clipboard.writeText('${conn.remoteAddr.toString()}')">Copy</button></li>`
        }).join('')
      }</ul>
    </li>`
  })
    .join('')
}

function update (element, newContent) {
  if (element.innerHTML !== newContent) {
    element.innerHTML = newContent
  }
}
