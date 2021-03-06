#!/usr/bin/env node
var fs = require('fs');
var marked = require('marked');
var mkdirp = require('mkdirp');
var glob = require('glob');
var ejs = require('ejs');
var path = require('path');
var semver = require('semver');

var input = path.resolve(process.argv[2]);
var output = path.resolve(process.argv[3]);
var template = path.resolve(process.argv[4]);

var config = {
  postsPerPage: 5
};

console.error("argv=%j", process.argv)

fs.readFile(template, 'utf8', function(er, contents) {
  if (er) throw er;
  template = ejs.compile(contents, template);
  readInput();
});

function readInput() {
  glob(input + '/**/*.md', function(er, files) {
    if (er) throw er;
    readFiles(files);
  });
}

function readFiles(files) {
  var n = files.length;
  var data = { files: {}, feeds: {}, posts: {}};

  files.forEach(function(file) {
    fs.readFile(file, 'utf8', next(file));
  });

  function next(file) { return function(er, contents) {
    if (er) throw er;
    if (contents) {
      contents = parseFile(file, contents);
      if (contents) {
        data.files[file] = contents
      }
    }
    if (--n === 0) {
      buildOutput(data);
    }
  }}
}

function parseFile(file, contents) {
  var c = contents.split('\n\n');
  var head = c.shift();
  c = c.join('\n\n');
  var post = head.split('\n').reduce(function(set, kv) {
    kv = kv.split(':');
    var key = kv.shift().trim();
    var val = kv.join(':').trim();
    set[key] = val;
    return set;
  }, {});
  if (post.status && post.status !== 'publish') return null;
  post.body = c;
  return post;
}

function buildPermalinks(data) {
  Object.keys(data.files).forEach(function(k) {
    data.posts[k] = buildPermalink(k, data.files[k]);
  });
}

function buildPermalink(key, post) {
  var data = {};
  data.pageid = post.slug;
  data.title = post.title;
  data.content = post.content = marked.parse(post.body);

  // Fix for chjj/marked#56
  data.content = post.content = data.content
    .replace(/<a href="([^"]+)&lt;\/a&gt;">\1&lt;\/a&gt;/g, '$1');

  data.post = post;

  var d = post.date = new Date(post.date);

  var y = d.getYear() + 1900;
  var m = d.getMonth() + 1;
  if (m < 10) m = '0' + m;
  var d = d.getDate();
  if (d < 10) d = '0' + d;
  var uri = '/' + y + '/' + m + '/' + d + '/' + post.slug + '/';
  post.data = data;
  post.uri = uri;

  post.permalink = data.permalink = uri;
  return data;
}

function writeFile(uri, data) {
  data.uri = path.join(data.uri);
  uri = path.join(uri);
  var contents = template(data);
  var outdir = path.join(output, uri);
  mkdirp(outdir, function(er) {
    if (er) throw er;
    var file = path.resolve(outdir, 'index.html');
    fs.writeFile(file, contents, 'utf8', function(er) {
      if (er) throw er;
      console.log('wrote: ', data.pageid, path.relative(process.cwd(), file));
    });
  });
}

// sort in reverse chronological order
// prune out any releases that are not the most recent on their branch.
function buildFeeds(data) {
  // first, sort by date.
  var posts = Object.keys(data.posts).map(function(k) {
    return data.posts[k].post;
  }).sort(function(a, b) {
    a = a.date.getTime();
    b = b.date.getTime();
    return (a === b) ? 0 : a > b ? -1 : 1;
  })

  // separate release posts by release families.
  var releases = posts.reduce(function(releases, post) {
    if (post.category !== 'release') return releases;
    var ver = semver.parse(post.version);
    if (!ver) return;
    var major = +ver[1];
    var minor = +ver[2];
    var patch = +ver[3];
    var family = [major, minor];
    ver = [major, minor, patch, post];
    if (family[1] % 2) family[1]++;
    family = family.join('.');
    post.family = family;
    releases[family] = releases[family] || [];
    releases[family].push(post);
    return releases;
  }, {});

  // separate by categories.
  var categories = posts.reduce(function(categories, post) {
    if (!post.category) return categories;
    if (!categories[post.category]) {
      categories[post.category] = [];
    }
    categories[post.category].push(post);
    return categories;
  }, {});

  // paginate categories.
  for (var cat in categories) {
    categories[cat] = paginate(categories[cat], cat);
  }

  // filter non-latest release notices out of main feeds.
  var main = posts.filter(function(post) {
    if (post.version && post.family && post !== releases[post.family][0]) {
      return false;
    }
    return true;
  });

  // add previous/next based on main feed.
  main.forEach(function (post, i, posts) {
    post.next = posts[i - 1];
    post.prev = posts[i + 1];
  })

  // paginate each feed.
  main = paginate(main, '');

  // put previous/next links on orphaned old releases so you can get back
  for (var family in releases) {
    releases[family].forEach(function(post, i, family) {
      if (!post.next) post.next = family[i - 1];
      if (!post.next) post.next = family[0].next;
      // if (!post.next) post.next = family[0];

      if (!post.prev) post.prev = family[i + 1];
      if (!post.prev) post.prev = family[0].prev;
    });
    // paginate
    releases[family] = paginate(releases[family], 'release-' + family);
  }

  // paginate
  data.feeds = {
    main: main,
    categories: categories,
    releases: releases
  };
}

function paginate(set, title) {
  var pp = config.postsPerPage || 5
  var pages = [];
  for (var i = 0; i < set.length; i += pp) {
    pages.push(set.slice(i, i + pp));
  }
  var id = title.replace(/[^a-zA-Z0-9.]+/g, '-');
  return { id: id || 'index', pageid: id, posts: set, pages: pages, title: title };
}

function writePermalinks(data) {
  Object.keys(data.posts).forEach(function(k) {
    var post = data.posts[k];
    writeFile(post.permalink, post);
  });
}

function writeFeeds(data) {
  writeFeed(data.feeds.main);

  for (var feed in data.feeds.categories) {
    writeFeed(data.feeds.categories[feed]);
  }
  for (var feed in data.feeds.releases) {
    writeFeed(data.feeds.releases[feed]);
  }
}

function writeFeed(feed) {
  var title = feed.title;
  feed.pages.forEach(function(page, p, pages) {
    writePaginated(feed.title, page, p, pages.length, feed.id);
  });
}

function writePaginated(title, posts, p, total, id) {
  var uri = '/' + encodeURIComponent(title) + '/';
  var d = {
    title: title,
    page: p,
    posts: posts,
    total: total,
    paginated: true,
    pageid: id + '-' + p,
    uri: uri
  };
  if (p === 0) {
    writeFile(uri, d);
  }
  writeFile(uri + p, d);
}

function buildOutput(data) {
  buildPermalinks(data);
  buildFeeds(data);
  writePermalinks(data);
  writeFeeds(data);
}

