const QQ_MUSICU_API_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const QQ_MUSICU_COMM = {
  ct: "11",
  cv: "1003006",
  v: "1003006",
  os_ver: "15",
  phonetype: "24122RKC7C",
  tmeAppID: "qqmusiclight",
  nettype: "NETWORK_WIFI"
};

function postMusicu(module, method, param) {
  const body = JSON.stringify({
    comm: QQ_MUSICU_COMM,
    req_0: {
      method: method,
      module: module,
      param: param
    }
  });
  const text = Platform.http.postText(QQ_MUSICU_API_URL, body, {
    contentType: "application/json; charset=utf-8",
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  return JSON.parse(text);
}

function randomSearchId() {
  return String(Math.floor(10000000000000000 + Math.random() * 80000000000000000));
}
