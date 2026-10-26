// Original, curated vocabulary: 512 distinct lowercase English words, at most eight letters.
const words = `acorn alder almond amber anchor apple apron arbor arch arrow ash aspen
atlas attic autumn avocado axle badger bagel bamboo banana barley basil basket
bass bat bay beach beacon bean bear beaver beech beet bell bench
berry birch bird bison blanket bloom blossom blue bluebell boat bonnet book
bookcase booth bottle boulder bowl branch breeze brick bridge brook broom brush
bubble bucket bud buffalo bugle bunny butter button cabin cactus cake camel
candle candy canoe canvas canyon cap cape carpet carrot cart castle cedar
cello chair chalk charm cherry chess chest chick chime chipmunk chisel cider
circle citrus clam clay cliff cloak cloud clover coast cocoa coconut cod
coffee comet compass coral cork corn cotton cove crane creek crest cricket
crown cube cup curtain cypress dahlia daisy dam dapple dawn deer delta
den desert dew diamond dish dock dolphin dome dove dragon drum duck
dune dusk eagle earth echo elm ember emerald engine falcon farm feather
fern ferry field fig fin finch fir firefly fish flag flannel flax
fleece flint flora flower flute foam forest fork fossil fountain fox frame
frost fruit galley garden garlic gate gazelle gem ginger glacier glass glen
globe glow goat gold goose grain grape grass gravel grove gull gum
guppy harbor hare harp harvest hat hawk hazel hearth heath hedge heron
hill hive holly honey hoof horn horse hound hut ice iceberg igloo
indigo iris island ivory ivy jacket jade jaguar jar jasmine jasper jay
jelly jet jewel jigsaw juniper kale kayak kettle key kite kitten kiwi
knoll koala lace lagoon lake lamb lamp lantern larch lark leaf leek
lemon leopard letter lettuce lilac lily lime linen lion lizard llama loaf
lobster lodge log lotus lumber lunar lynx lyre maple marble marigold marsh
mat meadow melon mesa meteor mica mint mirror mist mitten moon moor
moose moss moth mountain mouse mug mulberry mushroom mussel mustard narwhal nest
nettle nickel night node nook nut nutmeg oak oar oat ocean ochre
olive onion onyx opal orange orchid oriole osprey otter owl oyster paddle
palm panda pansy paper parrot parsnip path patio peach pearl pebble pecan
pelican pepper perch petal piano pickle pigeon pillow pine planet plum plume
pocket pond pony poplar poppy porch potato prairie prism puffin pumpkin puppy
puzzle quail quartz quilt quince rabbit raccoon raft rain rainbow raven ray
reed reef ribbon rice ridge river road robin rock rocket root rose
rosemary rowan ruby rug sage sail salmon salt sand sandal sapling satin
saucer savanna scallop scarf seal seed shade shell shield shoal shore shrub
silk silver slate sleigh slope snail snow soap sock sparrow spice spider
spoon spruce square squirrel stable stair star stone stork storm stream string
sugar summit sun sunset surf swan sweetgum sycamore table taco tail tapir
tart teal temple tern thyme tide tiger tile timber tin toad toast
topaz torch towel tower trail tree trout tulip tundra twig umber urn
valley vanilla vase velvet vine viola violet walnut walrus warbler water wave
wax weasel wheat willow wind window wing winter wolf wood wool wren
yam yarrow yellow yew yogurt zebra zinc zinnia`.split(/\s+/);

export function randomMailboxName(): string {
  // 512 divides the 16-bit sample space exactly; each of the three draws is unbiased.
  const samples = crypto.getRandomValues(new Uint16Array(3));
  return Array.from(samples, (sample) => words[sample % words.length]!).join("-");
}
