export default async function handler(req, res) {
  const file = req.query.file;

  if (!file || !file.endsWith(".html")) {
    return res.status(400).send("Invalid file");
  }

  const url =
    "https://dn721907.ca.archive.org/0/items/ugsfiles/" +
    encodeURIComponent(file);

  const response = await fetch(url);

  if (!response.ok) {
    return res.status(response.status).send("Game not found");
  }

  let html = await response.text();

  const base =
    '<base href="https://dn721907.ca.archive.org/0/items/ugsfiles/">';

  if (/<head[\s>]/i.test(html)) {
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1>${base}`
    );
  }

  res.setHeader(
    "Content-Type",
    "text/html; charset=utf-8"
  );

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.status(200).send(html);
}
