from PIL import Image
R = "/workspace/jots-t1516/cliff-renders/"
a = Image.open(R + "_p1-02a.png"); b = Image.open(R + "_p1-02b.png")
W = max(a.width, b.width); out = Image.new("RGB", (W, a.height + b.height), (20, 20, 20))
out.paste(a, (0, 0)); out.paste(b, (0, a.height)); out.save(R + "p1-02-section-side-cut.png", optimize=True)
print("composite", out.size)
