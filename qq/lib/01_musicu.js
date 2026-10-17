const QQ_MUSICU_API_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
// u.y.qq.com 在部分海外地区被风控（code 2001 空结果），shu6 桌面入口可用
const QQ_MUSICU_DESKTOP_URL = "https://shu6.y.qq.com/cgi-bin/musicu.fcg";
const QQ_WEB_SEARCH_URL = "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp";
const QQ_MUSICU_COMM = {
  ct: "11",
  cv: "1003006",
  v: "1003006",
  os_ver: "15",
  phonetype: "24122RKC7C",
  tmeAppID: "qqmusiclight",
  nettype: "NETWORK_WIFI"
};
const QQ_DESKTOP_COMM = {
  ct: "19",
  cv: "1873",
  uin: "0"
};

function postMusicuAt(url, comm, module, method, param) {
  const body = JSON.stringify({
    comm: comm,
    req_0: {
      method: method,
      module: module,
      param: param
    }
  });
  const text = Platform.http.postText(url, body, {
    contentType: "application/json; charset=utf-8",
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  return JSON.parse(text);
}

function postMusicu(module, method, param) {
  return postMusicuAt(QQ_MUSICU_API_URL, QQ_MUSICU_COMM, module, method, param);
}

function postMusicuDesktop(module, method, param) {
  return postMusicuAt(QQ_MUSICU_DESKTOP_URL, QQ_DESKTOP_COMM, module, method, param);
}

// 网页版搜索接口；不带 Referer 时会静默返回空结果
function getWebSearch(query, page, pageSize) {
  const url = QQ_WEB_SEARCH_URL + "?format=json&aggr=1&w=" + encodeURIComponent(String(query || "")) +
    "&n=" + Number(pageSize || 20) + "&p=" + Number(page || 1);
  const text = Platform.http.getText(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://y.qq.com/"
    }
  });
  return JSON.parse(text);
}

function randomSearchId() {
  return String(Math.floor(10000000000000000 + Math.random() * 80000000000000000));
}
