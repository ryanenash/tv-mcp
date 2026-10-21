// A minimal TV-style app: hash routes, native focus moved by a geometric spatial navigator on the arrow
// keys, Enter to select, Backspace to go back, a first-launch welcome dialog and an on-screen keyboard.
;(function () {
  var CATALOGUE = {
    featured: ['Northern Lights', 'Harbour Town', 'The Long Road', 'Signal Lost'],
    drama: ['Quiet Rooms', 'Second Act', 'Paper Crowns', 'Low Tide'],
  }
  var WELCOME_KEY = 'demoWelcomeSeen'
  var page = document.getElementById('page')
  var dialogRoot = document.getElementById('dialog-root')
  var query = ''
  var status = ''
  var token = ''

  function setStatus(text) {
    status = text
    var node = document.getElementById('settings-status')
    if (node) node.textContent = text
  }

  function xhr(method, url, headers, done) {
    var req = new XMLHttpRequest()
    req.open(method, url)
    for (var k in headers) req.setRequestHeader(k, headers[k])
    req.onload = function () {
      done(req.status, req.responseText)
    }
    req.send()
  }

  // Sign in the way fetch wrappers such as ky do it: a Request object carrying the body.
  function signIn() {
    var request = new Request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@example.test', password: 'hunter2' }),
    })
    fetch(request)
      .then(function (r) {
        return r.json()
      })
      .then(function (body) {
        token = body.token
        xhr('GET', '/api/profile', { Authorization: 'Bearer ' + token }, function (code) {
          setStatus(code === 200 ? 'Signed in' : 'Profile failed')
        })
      })
  }

  // A slow request started first and a fast one after: they complete in the opposite order. A loading overlay
  // covers the screen meanwhile, while keys still reach the page underneath (as real splash screens do).
  function refresh() {
    setStatus('Refreshing')
    var overlay = el('div', { class: 'splash', 'data-splash': '' }, ['Loading…'])
    document.body.appendChild(overlay)
    var left = 3
    var finish = function () {
      if (--left > 0) return
      setStatus('Refreshed')
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
    }
    xhr('GET', '/api/slow?ms=1500', {}, finish)
    fetch('/api/fast').then(finish)
    fetch('/api/big').then(function (r) {
      return r.text().then(finish)
    })
    if (navigator.sendBeacon) navigator.sendBeacon('/api/events', JSON.stringify({ event: 'refresh' }))
    // A media segment the way JavaScript players load them (XHR arraybuffer).
    var segment = new XMLHttpRequest()
    segment.open('GET', '/api/segment.m4s')
    segment.responseType = 'arraybuffer'
    segment.send()
    // A live channel: one message out, the echo back, then close.
    var socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/ws')
    socket.onopen = function () {
      socket.send(JSON.stringify({ type: 'hello', token: 'ws-client-secret' }))
    }
    socket.onmessage = function () {
      socket.close(1000)
    }
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    for (var k in attrs) node.setAttribute(k, attrs[k])
    ;(children || []).forEach(function (c) {
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return node
  }

  function focusables(root) {
    return Array.prototype.slice.call((root || document).querySelectorAll('[data-focus-id]')).filter(function (n) {
      return n.getBoundingClientRect().width > 0
    })
  }

  function focusFirst(root) {
    var first = focusables(root)[0]
    if (first) first.focus()
  }

  // Nearest focusable in the pressed direction, weighting off-axis distance more heavily.
  function move(dir) {
    var scope = dialogRoot.firstChild || document
    var current = document.activeElement
    if (!current || !current.getAttribute('data-focus-id')) return focusFirst(scope)
    var a = current.getBoundingClientRect()
    var ax = a.left + a.width / 2
    var ay = a.top + a.height / 2
    var best = null
    var bestScore = Infinity
    focusables(scope).forEach(function (n) {
      if (n === current) return
      var b = n.getBoundingClientRect()
      var dx = b.left + b.width / 2 - ax
      var dy = b.top + b.height / 2 - ay
      var ok =
        (dir === 'left' && dx < -1) ||
        (dir === 'right' && dx > 1) ||
        (dir === 'up' && dy < -1) ||
        (dir === 'down' && dy > 1)
      if (!ok) return
      var along = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy)
      var across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx)
      var score = along + across * 3
      if (score < bestScore) {
        bestScore = score
        best = n
      }
    })
    if (best) best.focus()
  }

  function render() {
    var route = location.hash || '#/home'
    page.innerHTML = ''
    if (route.indexOf('#/details/') === 0) {
      var title = decodeURIComponent(route.slice('#/details/'.length))
      page.appendChild(el('h1', {}, [title]))
      page.appendChild(el('p', {}, ['A demo programme page. Press Back to return.']))
      var play = el(
        'button',
        {
          'data-focus-id': 'details-play',
          'data-focus-section': 'details',
          'data-href': 'player.html?title=' + encodeURIComponent(title),
        },
        ['Play'],
      )
      // `?promo=late`: the page loads slowly and the marketing popup lands while it does.
      if (/[?&]promo=late/.test(location.search)) {
        setTimeout(showPromo, 300)
        setTimeout(function () {
          page.appendChild(play)
          if (!dialogRoot.firstChild) play.focus()
        }, 1000)
        return
      }
      page.appendChild(play)
    } else if (route === '#/search') {
      page.appendChild(el('h1', {}, ['Search']))
      page.appendChild(
        el('div', { class: 'field', id: 'search-field', role: 'textbox', 'aria-label': 'Search text' }, [query]),
      )
      var keys = el('div', { class: 'keyboard', 'data-focus-section': 'searchKeyboard' })
      'abcdefghijklmnopqrstuvwxyz'.split('').forEach(function (c) {
        keys.appendChild(el('button', { 'data-focus-id': 'key-' + c, 'data-key': c }, [c]))
      })
      keys.appendChild(el('button', { 'data-focus-id': 'key-space', 'data-key': ' ', class: 'wide' }, ['Space']))
      keys.appendChild(el('button', { 'data-focus-id': 'key-delete', 'data-key': '\b', class: 'wide' }, ['Delete']))
      page.appendChild(keys)
      page.appendChild(el('input', { type: 'hidden', id: 'search-input', value: query }))
    } else if (route === '#/settings') {
      page.appendChild(el('h1', {}, ['Settings']))
      var section = el('div', { 'data-focus-section': 'settings' })
      section.appendChild(el('button', { 'data-focus-id': 'settings-signin', 'data-action': 'signin' }, ['Sign in']))
      section.appendChild(
        el('button', { 'data-focus-id': 'settings-refresh', 'data-action': 'refresh' }, ['Refresh data']),
      )
      section.appendChild(el('button', { 'data-focus-id': 'settings-reset', 'data-action': 'reset' }, ['Reset app']))
      section.appendChild(el('p', { id: 'settings-status', 'aria-live': 'polite' }, [status]))
      page.appendChild(section)
    } else {
      page.appendChild(el('h1', {}, ['Home']))
      Object.keys(CATALOGUE).forEach(function (name) {
        page.appendChild(el('h2', {}, [name === 'featured' ? 'Featured' : 'Drama']))
        var rail = el('div', { class: 'rail', 'data-focus-section': name + 'Rail' })
        CATALOGUE[name].forEach(function (t, i) {
          rail.appendChild(
            el(
              'button',
              { class: 'tile', 'data-focus-id': name + '-' + i, 'data-route': '#/details/' + encodeURIComponent(t) },
              [t],
            ),
          )
        })
        page.appendChild(rail)
      })
    }
    if (!dialogRoot.firstChild) focusFirst(page)
  }

  function showWelcome() {
    var box = el(
      'div',
      {
        class: 'dialog',
        role: 'dialog',
        'aria-label': 'Welcome',
        'data-focus-section': 'welcomeDialog',
        'data-focus-scope': 'modal',
      },
      [
        el('div', {}, [
          el('h2', {}, ['Welcome to Demo TV']),
          el('p', {}, ['Browse programmes with the arrow keys.']),
          el('button', { 'data-focus-id': 'welcome-continue', 'data-action': 'welcome' }, ['Continue']),
        ]),
      ],
    )
    dialogRoot.appendChild(box)
    focusFirst(box)
  }

  // A marketing popup that may appear over any screen; `?promo=1` shows it once on load.
  function showPromo() {
    var box = el('div', { class: 'dialog', role: 'dialog', 'aria-label': 'Offer', 'data-promo': '' }, [
      el('div', {}, [
        el('h2', {}, ['New this week']),
        el('button', { 'data-focus-id': 'promo-watch', 'data-route': '#/details/Signal%20Lost' }, ['Watch now']),
        el('button', { 'data-focus-id': 'promo-close', 'data-action': 'promo-close' }, ['Not now']),
      ]),
    ])
    dialogRoot.appendChild(box)
    focusFirst(box)
  }

  function activate(node) {
    var action = node.getAttribute('data-action')
    var key = node.getAttribute('data-key')
    var target = node.getAttribute('data-route')
    var href = node.getAttribute('data-href')
    if (action === 'signin') {
      signIn()
    } else if (action === 'refresh') {
      refresh()
    } else if (action === 'welcome') {
      localStorage.setItem(WELCOME_KEY, '1')
      dialogRoot.innerHTML = ''
      focusFirst(page)
    } else if (action === 'promo-close') {
      dialogRoot.innerHTML = ''
      focusFirst(page)
    } else if (action === 'reset') {
      localStorage.clear()
      location.href = location.origin + '/'
    } else if (key !== null) {
      query = key === '\b' ? query.slice(0, -1) : query + key
      document.getElementById('search-field').textContent = query
      document.getElementById('search-input').value = query
    } else if (href) {
      location.href = href
    } else if (target) {
      location.hash = target
    }
  }

  document.addEventListener('keydown', function (e) {
    var code = e.keyCode
    if (code === 37) move('left')
    else if (code === 38) move('up')
    else if (code === 39) move('right')
    else if (code === 40) move('down')
    else if (code === 13 && document.activeElement && document.activeElement.getAttribute('data-focus-id'))
      activate(document.activeElement)
    else if (code === 8 && !dialogRoot.firstChild && location.hash && location.hash !== '#/home') history.back()
    else return
    e.preventDefault()
  })

  window.addEventListener('hashchange', render)
  render()
  // Console output of the kinds apps produce: styled, with objects (one circular), and JSON inside a string.
  var bootInfo = { name: 'boot', nested: { level: 2 }, token: 'console-secret' }
  bootInfo.self = bootInfo
  console.log('%c[demo]%c boot %s', 'color:#ffd23f', '', 'ok', bootInfo)
  console.info('[demo] json ' + JSON.stringify({ user: 'viewer', password: 'console-pass' }))
  // Packaged (file://) copies have no backend.
  var online = /^https?:$/.test(location.protocol)
  if (online)
    fetch('/api/catalogue').then(function (r) {
      return r.json()
    })
  // An app that renders on a server can forward the exchanges it made there; this one pretends to.
  var bridge = window.__tvmcp
  if (online && bridge && bridge.recordExchange) {
    var now = Date.now()
    bridge.recordExchange({
      origin: 'server',
      method: 'GET',
      url: 'https://backend.example.test/config?token=ssr-secret&locale=en',
      startedAt: now - 900,
      endedAt: now - 700,
      status: 200,
      mimeType: 'application/json',
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: JSON.stringify({ config: { theme: 'dark' }, apiKey: 'k-secret-789' }),
    })
  }
  if (!localStorage.getItem(WELCOME_KEY)) showWelcome()
  else if (/[?&]promo=1/.test(location.search)) showPromo()
})()
