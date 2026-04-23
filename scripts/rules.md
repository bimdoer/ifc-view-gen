# floor plan
image size: 540x270px (legend & label included)
centre of the door: bounding box middle point
centre for the placement: The center of the door must be positioned at the horizontal midpoint of the image (X-axis) and vertically centered between the top edge and the top edge of the legend (Y-axis).
visualized context dimension: bounding box of the door + 0.5m in each direction
cropping: all the geometry get cropped at the edges of the image
Scale is fixed at 120 px/m (true scale).
Do not fit geometry to image size.
Crop instead.
export format: webp

# elevationf ront and back
image size: 540x540px (legend & label included)
centre of the door: bounding box middle point
centre for the placement: The center of the door must be positioned at the horizontal midpoint of the image (X-axis) and vertically centered between the top edge and the top edge of the legend (Y-axis).

Visualized context:

1) Horizontal extent (X/Y):
Use a bounding box around the door, extended by:
- ±0.5 m in X direction
- ±1.0 m in Y direction

Only include elements all (e.g. slabs, walls, ceilings, windows, building element parts, electrical components) that intersect this horizontal bounding box.

2) Vertical extent (Z):
The final visible geometry is limited to the storey height.

Apply a vertical clipping range defined as:
- lower bound: storey elevation - 0.35 m
- upper bound: top of storey (OK storey height)

3) Combination rule:
The final geometry is the intersection of:
- the horizontal bounding box (around the door)
AND
- the vertical clipping range (storey height with -0.35 m offset)

Elements outside this combined volume must not be shown.

cropping: all the geometry get cropped at the edges of the image
Scale is fixed at 120 px/m (true scale).
Do not fit geometry to image size.
Crop instead.
export format: webp