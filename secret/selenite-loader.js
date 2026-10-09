/*
 * Selenite game loader
 * ---------------------------------------------------------------
 * Used ONLY for the "Selenite" source on /secret.
 * (Archive.org games still use /api/game.js.)
 *
 * Everything is fetched live from the GitLab repo:
 *   https://gitlab.com/LevittP/selenite-unofficial  ->  semag/<game>/
 *
 * A Selenite game folder looks like this (example: bitlife):
 *
 *   semag/bitlife/
 *     index.html          <- entry page (loads Build/*, TemplateData/*)
 *     bitlife.png         <- the game's photo (named after the folder)
 *     logo.png, splash.png  <- assets used INSIDE the game
 *     Build/              <- UnityLoader.js, *.unityweb, .json
 *     TemplateData/
 *
 * Public API (window.SeleniteLoader):
 *   listGames()        -> Promise<[{key, source, folder, name, label}]>
 *   thumbnailURL(game) -> Promise<string|null>
 *   loadGame(game)     -> Promise<string>   (HTML for iframe.srcdoc)
 */

(function () {

  "use strict";


  /* ---------- Configuration ---------- */

  var PROJECT = "LevittP/selenite-unofficial";
  var BRANCH = "main";
  var GAMES_PATH = "semag";

  var API =
    "https://gitlab.com/api/v4/projects/" +
    encodeURIComponent(PROJECT);

  /* jsDelivr: serves repo files with the right MIME types + CORS. */
  var CDN =
    "https://cdn.jsdelivr.net/gl/" +
    PROJECT + "@" + BRANCH + "/";

  /* GitLab raw: fallback if jsDelivr is unavailable. */
  var RAW =
    "https://gitlab.com/" + PROJECT +
    "/-/raw/" + BRANCH + "/";

  var HOUR = 60 * 60 * 1000;

  /* Scripts that belong to the real Selenite website and don't
     exist in a game folder (e.g. <script src="/js/all.min.js">). */
  var SITE_SCRIPT_RE = /^\/(?:js\/)?all\.min\.js(?:[?#].*)?$/i;

  var IMAGE_RE = /\.(png|jpe?g|webp|gif|avif|svg)$/i;
  var HTML_RE = /\.html?$/i;

  /* Images that are part of the game, not its photo. */
  var NOT_PHOTO_RE =
    /(splash|logo|progress|loading|favicon|sprite|background|bg)/i;

  var PHOTO_HINT_RE =
    /(thumb|icon|cover|preview|poster|banner|image|photo)/i;


  /* ---------- Small helpers ---------- */

  function cacheGet(key, maxAge) {

    try {

      var raw = localStorage.getItem("selenite:" + key);

      if (!raw) return null;

      var entry = JSON.parse(raw);

      if (Date.now() - entry.t > maxAge) return null;

      return entry.v;

    } catch (error) {

      return null;

    }

  }


  function cacheSet(key, value) {

    try {

      localStorage.setItem(
        "selenite:" + key,
        JSON.stringify({ t: Date.now(), v: value })
      );

    } catch (error) {

      /* storage blocked - ignore */

    }

  }


  function encodePath(path) {

    return path
      .split("/")
      .map(encodeURIComponent)
      .join("/");

  }


  function normalize(value) {

    return String(value)
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, "")
      .replace(/[^a-z0-9]/g, "");

  }


  function fileURL(game, relativePath) {

    return (
      CDN +
      encodePath(
        GAMES_PATH + "/" + game.folder + "/" + relativePath
      )
    );

  }


  async function fetchText(url) {

    var response = await fetch(url);

    if (!response.ok) {

      throw new Error("HTTP " + response.status);

    }

    return response.text();

  }


  function gitlabRawURL(repoPath) {

    return (
      API +
      "/repository/files/" +
      encodeURIComponent(repoPath) +
      "/raw?ref=" +
      encodeURIComponent(BRANCH)
    );

  }


  function preload(url) {

    return new Promise(function (resolve) {

      var img = new Image();

      img.onload = function () { resolve(url); };
      img.onerror = function () { resolve(null); };

      img.src = url;

    });

  }


  /* ---------- GitLab API ---------- */

  async function gitlabTree(path, recursive, maxPages) {

    var all = [];

    for (var page = 1; page <= (maxPages || 50); page++) {

      var url =
        API + "/repository/tree?path=" +
        encodeURIComponent(path) +
        "&ref=" + encodeURIComponent(BRANCH) +
        "&per_page=100&page=" + page +
        (recursive ? "&recursive=true" : "");

      var response = await fetch(url);

      if (!response.ok) {

        throw new Error(
          "GitLab returned HTTP " + response.status
        );

      }

      var items = await response.json();

      all = all.concat(items);

      if (items.length < 100) break;

    }

    return all;

  }


  /* ---------- Game list ---------- */

  function displayName(folder) {

    var name =
      folder
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (name === name.toLowerCase()) {

      name = name.replace(/\b[a-z]/g, function (c) {
        return c.toUpperCase();
      });

    }

    return name;

  }


  async function listGames() {

    var folders = cacheGet("folders", HOUR);

    if (!folders) {

      var items = await gitlabTree(GAMES_PATH, false, 50);

      folders =
        items
          .filter(function (i) { return i.type === "tree"; })
          .map(function (i) { return i.name; });

      if (!folders.length) {

        throw new Error(
          "No game folders found in " + GAMES_PATH + "/"
        );

      }

      cacheSet("folders", folders);

    }

    return folders.map(function (folder) {

      return {
        key: "selenite:" + folder,
        source: "selenite",
        folder: folder,
        label: folder,
        name: displayName(folder)
      };

    });

  }


  /* ---------- Per-game info (entry file + photo) ---------- */

  function pickEntry(files) {

    var pages =
      files
        .filter(function (f) { return HTML_RE.test(f.name); })
        .sort(function (x, y) {

          var dx = x.name.split("/").length;
          var dy = y.name.split("/").length;

          if (dx !== dy) return dx - dy;

          return (
            (x.name.toLowerCase() === "index.html" ? 0 : 1) -
            (y.name.toLowerCase() === "index.html" ? 0 : 1)
          );

        });

    return pages.length ? pages[0].name : null;

  }


  /*
   * Photo = the image named after the game folder (bitlife.png).
   * Otherwise a "thumb/icon/cover..." image, otherwise any image
   * that is not obviously a game asset (logo, splash...).
   */

  function pickImage(files, folder) {

    var images =
      files
        .filter(function (f) { return IMAGE_RE.test(f.name); })
        .sort(function (x, y) {
          return x.name.split("/").length - y.name.split("/").length;
        });

    if (!images.length) return null;

    var target = normalize(folder);

    var found =
      images.find(function (f) {
        return normalize(f.name.split("/").pop()) === target;
      }) ||
      images.find(function (f) {
        return normalize(f.name.split("/").pop()).indexOf(target) !== -1;
      }) ||
      images.find(function (f) {
        return PHOTO_HINT_RE.test(f.name) && !NOT_PHOTO_RE.test(f.name);
      }) ||
      images.find(function (f) {
        return !NOT_PHOTO_RE.test(f.name);
      }) ||
      images[0];

    return found.name;

  }


  function getInfo(game) {

    if (game.infoPromise) return game.infoPromise;

    game.infoPromise = (async function () {

      var cached = cacheGet("info:" + game.folder, 6 * HOUR);

      if (cached) return cached;

      var folderPath = GAMES_PATH + "/" + game.folder;
      var prefix = folderPath + "/";

      function toFiles(items) {

        return items
          .filter(function (i) { return i.type === "blob"; })
          .map(function (i) { return { name: i.path.slice(prefix.length) }; });

      }

      var files = toFiles(await gitlabTree(folderPath, false, 1));

      var entry = pickEntry(files);
      var image = pickImage(files, game.folder);

      /* Not at the top level? Look in sub-folders too. */

      if (!entry || !image) {

        try {

          var deep = toFiles(await gitlabTree(folderPath, true, 3));

          entry = entry || pickEntry(deep);
          image = image || pickImage(deep, game.folder);

        } catch (error) {

          console.warn("Selenite deep scan failed:", error);

        }

      }

      var info = { entry: entry, image: image };

      if (entry) cacheSet("info:" + game.folder, info);

      return info;

    })();

    game.infoPromise.catch(function () {
      game.infoPromise = null;
    });

    return game.infoPromise;

  }


  /* ---------- Thumbnails ---------- */

  async function thumbnailURL(game) {

    if (game.thumbURL !== undefined) return game.thumbURL;

    var cached = cacheGet("thumb:" + game.folder, 6 * HOUR);

    if (cached) {

      game.thumbURL = cached;

      return cached;

    }

    /* Fast path: <folder>.png - no API call needed. */

    var url = await preload(fileURL(game, game.folder + ".png"));

    /* Otherwise look at the folder contents. */

    if (!url) {

      try {

        var info = await getInfo(game);

        if (info.image) {

          url = await preload(fileURL(game, info.image));

        }

      } catch (error) {

        console.warn("Selenite thumbnail lookup failed:", error);

      }

    }

    game.thumbURL = url;

    if (url) cacheSet("thumb:" + game.folder, url);

    return url;

  }


  /* ---------- Loading a game ---------- */

  /*
   * Download the entry HTML: jsDelivr first, GitLab API second.
   * Returns { text, mode } or null.
   */

  async function tryEntry(repoPath) {

    try {

      return {
        text: await fetchText(CDN + encodePath(repoPath)),
        mode: "cdn"
      };

    } catch (cdnError) {

      console.warn("Selenite CDN failed for", repoPath, cdnError);

    }

    try {

      return {
        text: await fetchText(gitlabRawURL(repoPath)),
        mode: "gitlab"
      };

    } catch (gitlabError) {

      console.warn("Selenite GitLab failed for", repoPath, gitlabError);

    }

    return null;

  }


  /*
   * Turn the game's index.html into something that works inside
   * an iframe on THIS website:
   *   - removes Selenite-site-only scripts
   *   - points root-relative paths (/img/x.png) at the repo root
   *   - adds <base> so ./Build/..., ./TemplateData/... load from
   *     the game's folder
   *   - GitLab fallback: inlines scripts/styles (GitLab raw URLs
   *     are served as text/plain and can't be used as <script>)
   */

  async function prepareHtml(text, dirPath, mode) {

    var root = mode === "cdn" ? CDN : RAW;

    var baseURL = root + encodePath(dirPath);

    var doc =
      new DOMParser().parseFromString(text, "text/html");


    /* 1) Remove Selenite-site scripts. */

    Array.prototype.slice
      .call(doc.querySelectorAll("script[src]"))
      .forEach(function (script) {

        if (SITE_SCRIPT_RE.test(script.getAttribute("src"))) {
          script.remove();
        }

      });


    /* 2) Root-relative paths -> repo root. */

    Array.prototype.slice
      .call(doc.querySelectorAll("[src], link[href]"))
      .forEach(function (el) {

        ["src", "href"].forEach(function (attr) {

          if (attr === "href" && el.tagName !== "LINK") return;

          var value = el.getAttribute(attr);

          if (
            value &&
            value.charAt(0) === "/" &&
            value.charAt(1) !== "/"
          ) {

            el.setAttribute(attr, root + value.slice(1));

          }

        });

      });

    Array.prototype.slice
      .call(doc.querySelectorAll("style"))
      .forEach(function (style) {

        style.textContent =
          style.textContent.replace(
            /url\(\s*(['"]?)\/(?!\/)/g,
            "url($1" + root
          );

      });


    /* 3) GitLab fallback: inline scripts and stylesheets. */

    if (mode === "gitlab") {

      var scripts =
        Array.prototype.slice.call(doc.querySelectorAll("script[src]"));

      for (var i = 0; i < scripts.length; i++) {

        var script = scripts[i];

        var resolved =
          new URL(script.getAttribute("src"), baseURL).href;

        if (resolved.indexOf(RAW) !== 0) continue;

        try {

          var repoPath =
            decodeURIComponent(
              resolved.slice(RAW.length).split(/[?#]/)[0]
            );

          var code = await fetchText(gitlabRawURL(repoPath));

          var inline = doc.createElement("script");

          if (script.getAttribute("type")) {
            inline.setAttribute("type", script.getAttribute("type"));
          }

          inline.textContent = code.replace(/<\/script/gi, "<\\/script");

          script.replaceWith(inline);

        } catch (error) {

          console.warn("Could not inline", resolved, error);

        }

      }

      var sheets =
        Array.prototype.slice.call(
          doc.querySelectorAll('link[rel~="stylesheet"][href]')
        );

      for (var j = 0; j < sheets.length; j++) {

        var sheet = sheets[j];

        var sheetURL =
          new URL(sheet.getAttribute("href"), baseURL).href;

        if (sheetURL.indexOf(RAW) !== 0) continue;

        try {

          var sheetPath =
            decodeURIComponent(
              sheetURL.slice(RAW.length).split(/[?#]/)[0]
            );

          var css = await fetchText(gitlabRawURL(sheetPath));

          var styleEl = doc.createElement("style");

          styleEl.textContent = css;

          sheet.replaceWith(styleEl);

        } catch (error) {

          console.warn("Could not inline", sheetURL, error);

        }

      }

    }


    /* 4) <base> so relative files resolve to the game folder. */

    Array.prototype.slice
      .call(doc.querySelectorAll("base"))
      .forEach(function (b) { b.remove(); });

    var base = doc.createElement("base");

    base.setAttribute("href", baseURL);

    doc.head.insertBefore(base, doc.head.firstChild);


    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;

  }


  async function loadGame(game) {

    var folderPath = GAMES_PATH + "/" + game.folder + "/";

    var entry = "index.html";

    var result = await tryEntry(folderPath + entry);

    if (!result) {

      /* No index.html (or it failed): look at the folder. */

      var info = await getInfo(game);

      if (!info.entry) {

        throw new Error(
          "No HTML file found in this game's folder."
        );

      }

      if (info.entry !== entry) {

        entry = info.entry;

        result = await tryEntry(folderPath + entry);

      }

    }

    if (!result) {

      throw new Error(
        "Could not download this game from GitLab."
      );

    }

    var slash = entry.lastIndexOf("/");

    var dirPath =
      folderPath + (slash >= 0 ? entry.slice(0, slash + 1) : "");

    return prepareHtml(result.text, dirPath, result.mode);

  }


  window.SeleniteLoader = {
    listGames: listGames,
    thumbnailURL: thumbnailURL,
    loadGame: loadGame
  };

})();
