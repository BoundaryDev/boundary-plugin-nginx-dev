var _param = require('./param.json');
var _os = require('os');
var _http = require('http');
var _https = require('https');
var _request = require('request');
var _tools = require('graphdat-plugin-tools');

// remember the previous poll data so we can provide proper counts
var _previous = {};

// if we have a name and password, then add an auth header
var _httpOptions;
if (_param.username)
    _httpOptions = { auth: { user: _param.username, pass: _param.password, sendImmediately: true }};

// if we do not have a source, then set it
_param.source = _param.source || _os.hostname();

// get the natural difference between a and b
function diff(a, b)
{
    if (a == null || b == null)
        return 0;
    else
        return Math.max(a - b, 0);
}

// accumulate a value and return the difference from the previous value
function accumulate(key, new_value)
{
    if (key in _previous)
        old_value = _previous[key];
    else
        old_value = new_value;

    difference = diff(new_value, old_value);
    _previous[key] = new_value;
    return difference;
}

// validate the input, return 0 if its not an integer
function parse(x)
{
    if (x == null) return 0;

    var y = parseInt(x, 10);
    return (isNaN(y) ? 0 : y);
}

function parseStatsJson(body)
{
    // See http://nginx.org/en/docs/http/ngx_http_status_module.html for body format
    var data = JSON.parse(body);

    console.log('NGINX_ACTIVE_CONNECTIONS %d %s', data['connections']['active'] + data['connections']['idle'], _param.source);
    console.log('NGINX_WAITING %d %s', data['connections']['idle'], _param.source);
    var handled = data['connections']['accepted'] - data['connections']['dropped'];
    console.log('NGINX_HANDLED %d %s', accumulate('NGINX_HANDLED', handled), _param.source);
    console.log('NGINX_NOT_HANDLED %d %s', data['connections']['dropped'], _param.source);
    var requests = data['requests']['total'];
    console.log('NGINX_REQUESTS %d %s', accumulate('NGINX_REQUESTS', requests), _param.source);
    var requestsPerConnection = (requests > 0 && handled !== 0) ? requests/handled : 0;
    console.log('NGINX_REQUESTS_PER_CONNECTION %d %s', requestsPerConnection, _param.source);

    for (var zone_name in data.server_zones)
    {
        var zone = data.server_zones[zone_name];
        var src = _param.source + '_' + zone_name;
        console.log('NGINX_REQUESTS %d %s', accumulate('NGINX_REQUESTS_' + zone_name, zone['requests']), src);
        console.log('NGINX_RESPONSES %d %s', accumulate('NGINX_RESPONSES_' + zone_name, zone['responses']['total']), src);
        console.log('NGINX_TRAFFIC_SENT %d %s', accumulate('NGINX_TRAFFIC_SENT_' + zone_name, zone['sent']), src);
        console.log('NGINX_TRAFFIC_RECEIVED %d %s', accumulate('NGINX_TRAFFIC_RECEIVED_' + zone_name, zone['received']), src);
    }

    return true;
}

function parseStatsText(body)
{
    /*
    See http://nginx.org/en/docs/http/ngx_http_stub_status_module.html for body format.
    Sample response:

    Active connections: 1
    server accepts handled requests
     112 112 121
    Reading: 0 Writing: 1 Waiting: 0
     */
    var stats = {};
    body.split('\n').forEach(function(line)
    {
        if (line.indexOf('Active connections:') === 0)
        {
            var active = line.match(/(\w+):\s*(\d+)/);
            stats[active[1].toLowerCase()] = parse(active[2]);
        }
        else if (line.match(/\s*(\d+)\s+(\d+)\s+(\d+)\s*$/))
        {
            var match = line.match(/\s*(\d+)\s+(\d+)\s+(\d+)\s*$/);
            stats.accepts = parse(match[1]);
            stats.handled = parse(match[2]);
            stats.requests = parse(match[3]);
            stats.nothandled = stats.accepts - stats.handled;
        }
        else if (line.match(/(\w+):\s*(\d+)/))
        {
            while(true)
            {
                var kvp = line.match(/(\w+):\s*(\d+)/);
                if (!kvp)
                    break;

                stats[kvp[1].toLowerCase()] = parse(kvp[2]);
                line = line.replace(kvp[0], '');
            }
        }
    });
    return stats;
}

// call nginx and parse the stats
function getStats(cb)
{
    // call nginx to get the stats page
    _request.get(_param.url, _httpOptions, function(err, resp, body)
    {
        if (err)
            return cb(err);
        if (resp.statusCode === 401)
            return cb(new Error('Nginx returned with an error - recheck the username/password you provided'));
        if (resp.statusCode !== 200)
            return cb(new Error('Nginx returned with an error - recheck the URL you provided'));
        if (!body)
            return cb(new Error('Nginx statistics return empty'));

        // if response is json (from nginx enterprise edition) - parse accordingly.  otherwise, parse
        // as plain text (nginx community edition).
        var stats;
        if (resp.headers['content-type'] == 'application/json')
            stats = parseStatsJson(body);
        else
            stats = parseStatsText(body);

        return cb(null, stats);
    });
}

// get the stats, format the output and send to stdout
function poll(cb)
{
    getStats(function(err, current)
    {
        if (err)
            return console.error(err);

        // JSON parser handles its own response and gives us "true" - so ignore it if so
        if (current != true)
        {
            var handled = ('handled' in _previous) ? diff(current.handled, _previous.handled) : 0;
            var requests = ('requests' in _previous) ? diff(current.requests, _previous.requests) : 0;
            var requestsPerConnection = (requests > 0 && handled !== 0) ? requests / handled : 0;

            _previous = current;

            // Report
            console.log('NGINX_ACTIVE_CONNECTIONS %d %s', current.connections, _param.source);
            console.log('NGINX_READING %d %s', current.reading, _param.source);
            console.log('NGINX_WRITING %d %s', current.writing, _param.source);
            console.log('NGINX_WAITING %d %s', current.waiting, _param.source);
            console.log('NGINX_HANDLED %d %s', handled, _param.source);
            console.log('NGINX_NOT_HANDLED %d %s', current.nothandled, _param.source);
            console.log('NGINX_REQUESTS %d %s', requests, _param.source);
            console.log('NGINX_REQUESTS_PER_CONNECTION %d %s', requestsPerConnection, _param.source);
        }
    });

    setTimeout(poll, _param.pollInterval);
}

poll();
