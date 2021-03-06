module.exports = function({debug, debug_level, request, get_request_options, max_segments, cache_key}) {
  max_segments = max_segments || 20
  cache_key    = cache_key    ||  0

  const ts = []

  const ts_garbage_collect = function(start, count) {
    for (let i=start; i < (start + count); i++) {
      if (i >= ts.length) break

      ts[i].databuffer = undefined
    }
    ts.splice(start, count)
  }

  const regexs = {
    "ts_extension": /\.ts(?:[\?#]|$)/i,
    "ts_filename":  /^.*?\/([^\/]+\.ts).*$/i,
    "ts_sequence":  /^.*?(\d+\.ts).*$/i
  }

  const should_prefetch_url = function(url) {
    return regexs["ts_extension"].test(url)
  }

  const get_key_from_url = function(url) {
    switch (cache_key) {
      case 2:
        // full URL of .ts file
        return url
        break
      case 1:
        // full filename of .ts file
        return url.replace(regexs["ts_filename"], '$1')
        break
      case 0:
      default:
        // sequence number of .ts file w/ .ts file extension (ex: "123.ts")
        return url.replace(regexs["ts_sequence"], '$1')
        break
    }
  }

  const find_index_of_segment = function(url) {
    let key = get_key_from_url(url)
    let index
    for (let i=(ts.length - 1); i>=0; i--) {
      let segment = ts[i]  // {key, databuffer}
      if (segment && (segment.key === key)) {
        index = i
        break
      }
    }
    return index
  }

  const prefetch_segment = function(url) {
    if (! should_prefetch_url(url)) return

    let debug_url = (debug_level >= 3) ? url : get_key_from_url(url)

    let index = find_index_of_segment(url)
    if (index === undefined) {
      debug(1, 'prefetch (start):', debug_url)

      // placeholder to prevent multiple download requests
      index = ts.length
      ts[index] = {key: get_key_from_url(url), databuffer: false}

      let options = get_request_options(url)
      request(options, '', {binary: true, stream: false})
      .then(({response}) => {
        debug(1, `prefetch (complete, ${response.length} bytes):`, debug_url)

        // asynchronous callback could occur after garbage collection; the index could've changed
        index = find_index_of_segment(url)
        if (index === undefined) throw new Error('Prefetch completed after pending request was ejected from cache. Try increasing the "--max-segments" option.')

        let segment = ts[index].databuffer
        if (segment && (segment instanceof Array)) {
          segment.forEach((cb) => {
            cb(response)

            debug(1, 'cache (callback complete):', debug_url)
          })
        }
        ts[index].databuffer = response

        // cleanup: prune length of ts[] so it contains no more than "max_segments"
        if (ts.length > max_segments) {
          let overflow = ts.length - max_segments
          ts_garbage_collect(0, overflow)
        }
      })
      .catch((e) => {
        debug(1, 'prefetch (error):', debug_url)
        debug(2, 'prefetch (error):', e.message)

        // asynchronous callback could occur after garbage collection; the index could've changed
        index = find_index_of_segment(url)
        if (index !== undefined) ts_garbage_collect(index, 1)
      })
    }
  }

  const get_segment = function(url) {
    if (! should_prefetch_url(url)) return undefined

    let debug_url = (debug_level >= 3) ? url : get_key_from_url(url)

    let segment
    let index = find_index_of_segment(url)
    if (index !== undefined) {
      segment = ts[index].databuffer

      if ((segment === false) || (segment instanceof Array)) {
        debug(1, 'cache (pending prefetch):', debug_url)

        return false
      }
      debug(1, 'cache (hit):', debug_url)

      // cleanup: remove all previous segments
      // =====================================
      // todo:
      //   - why does this sometimes cause the video player to get stuck.. repeatedly request the .m3u8 file, but stop requesting any .ts segments?
      //   - is it a coincidence that commenting this line appears to stop such behavior?
      //   - could it possibly be a race condition? cleanup also occurs asynchronously when prefetch responses are received, but javascript (node) is single threaded.. and this code doesn't yield or use a timer.
      // =====================================
      // ts_garbage_collect(0, (index + 1))
    }
    else {
      debug(1, 'cache (miss):', debug_url)
    }
    return segment
  }

  const add_listener = function(url, cb) {
    if (! should_prefetch_url(url)) return false

    let debug_url = (debug_level >= 3) ? url : get_key_from_url(url)

    let segment
    let index = find_index_of_segment(url)
    if (index !== undefined) {
      segment = ts[index].databuffer

      if (segment === false) {
        ts[index].databuffer = [cb]

        debug(1, 'cache (callback added):', debug_url)
      }
      else if (segment instanceof Array) {
        ts[index].databuffer.push(cb)

        debug(1, 'cache (callback added):', debug_url)
      }
      else {
        cb(segment)

        debug(1, 'cache (callback complete):', debug_url)
      }
    }
    return true
  }

  if (debug_level >= 3) {
    setInterval(() => {
      let ts_cache_keys = []
      ts.forEach((cache) => ts_cache_keys.push(cache.key))
      debug(3, 'cache (keys):', JSON.stringify(ts_cache_keys))
    }, 5000)
  }

  return {
    prefetch_segment,
    get_segment,
    add_listener
  }
}
