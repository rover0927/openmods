# Forge 1.20.1 API 速查（Java / mojmap）

> 只覆盖 **MC 1.20.1 + Forge 47.x**（ForgeGradle 6.0.54 / Gradle 8.8 / JDK 17 / `official` 映射）。
> 签名以官方 MDK `forge-1.20.1-47.4.10-mdk.zip` 的 `ExampleMod.java` 与 Forge 47.4.10 javadoc 为准；本文没有的，先查 javadoc，不要凭记忆写。
> 核对日期：2026-11-16（对照 MDK 47.4.10 实机编译通过）。

## 1. 模组入口

```java
@Mod(ExampleMod.MODID)                       // net.minecraftforge.fml.common.Mod
public class ExampleMod {
    public static final String MODID = "examplemod";

    public ExampleMod(FMLJavaModLoadingContext context) {   // 47.3+ MDK 写法：构造器注入
        IEventBus modBus = context.getModEventBus();
        // DeferredRegister.register(modBus) / addListener / registerConfig 在这里
        MinecraftForge.EVENT_BUS.register(this);            // game bus
    }
}
```

- 47.4.x 的 `FMLJavaModLoadingContext.get()` 仍存在但已弃用；新代码用构造器参数（官方 MDK 如此）。
- 1.20.1 没有 `FMLPreInitializationEvent` 之类的生命周期事件，初始化全在构造器 + mod bus 监听器里。
- 配置注册：`context.registerConfig(ModConfig.Type.COMMON, Config.SPEC)`。

## 2. 双事件总线

| 总线 | 获取 | 用途 |
|---|---|---|
| mod bus | `context.getModEventBus()` | `DeferredRegister.register`、`FMLCommonSetupEvent`、`FMLClientSetupEvent`、`GatherDataEvent`、`BuildCreativeModeTabContentsEvent`、`RegisterCapabilitiesEvent` |
| game bus | `MinecraftForge.EVENT_BUS` | `ServerStartingEvent`、`PlayerEvent.*`、`LivingHurtEvent`、`BlockEvent.*`、`RegisterCommandsEvent`、tick 事件 |

`@SubscribeEvent` 的包是 `net.minecraftforge.eventbus.api.SubscribeEvent`。
`@Mod.EventBusSubscriber(modid = MODID, bus = Mod.EventBusSubscriber.Bus.FORGE)`：`Bus.FORGE` 是 game bus、`Bus.MOD` 是 mod bus；`value = Dist.CLIENT` 限定仅客户端加载。

常用事件：

| 事件 | 关键方法 |
|---|---|
| `net.minecraftforge.event.server.ServerStartingEvent` | `getServer()` → `MinecraftServer` |
| `net.minecraftforge.event.RegisterCommandsEvent` | `getDispatcher()` → `CommandDispatcher<CommandSourceStack>` |
| `net.minecraftforge.event.entity.living.LivingHurtEvent` | `getEntity()` / `getSource()` / `getAmount()` / `setAmount(float)` |
| `net.minecraftforge.event.level.BlockEvent.BreakEvent` | `getPlayer()` / `getPos()` / `getState()` |
| `net.minecraftforge.event.entity.player.PlayerEvent.PlayerLoggedInEvent` | `getEntity()` |
| `net.minecraftforge.event.TickEvent.ServerTickEvent` | `getServer()`、`getPhase()` → `TickEvent.Phase`（Pre/Post 子类在 1.20.2+ 才拆，1.20.1 用 phase 判断） |
| `net.minecraftforge.event.BuildCreativeModeTabContentsEvent` | `getTabKey()`、`accept(...)` |

## 3. 注册（DeferredRegister）

```java
public static final DeferredRegister<Block> BLOCKS = DeferredRegister.create(ForgeRegistries.BLOCKS, MODID);
public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, MODID);
public static final DeferredRegister<CreativeModeTab> TABS =
    DeferredRegister.create(Registries.CREATIVE_MODE_TAB, MODID);   // net.minecraft.core.registries.Registries

public static final RegistryObject<Block> EXAMPLE_BLOCK = BLOCKS.register("example_block",
    () -> new Block(BlockBehaviour.Properties.of().mapColor(MapColor.STONE).strength(3.0F)));
public static final RegistryObject<Item> EXAMPLE_BLOCK_ITEM = ITEMS.register("example_block",
    () -> new BlockItem(EXAMPLE_BLOCK.get(), new Item.Properties()));
public static final RegistryObject<Item> EXAMPLE_ITEM = ITEMS.register("example_item",
    () -> new Item(new Item.Properties().food(new FoodProperties.Builder()
        .nutrition(1).saturationMod(2f).alwaysEat().build())));

public static final RegistryObject<CreativeModeTab> EXAMPLE_TAB = TABS.register("example_tab",
    () -> CreativeModeTab.builder()
        .withTabsBefore(CreativeModeTabs.COMBAT)
        .icon(() -> EXAMPLE_ITEM.get().getDefaultInstance())
        .displayItems((params, output) -> output.accept(EXAMPLE_ITEM.get()))
        .build());
```

- 1.20.1 的方块属性是 `BlockBehaviour.Properties.of()`；`AbstractBlock.Properties` 是 1.16.5 的写法。
- `DeferredRegister.create(IForgeRegistry<T>, modid)` 与 `create(RegistryKey<Registry<T>>, modid)` 都可用；`Registries.*` 用于非 Forge 注册表（如 `CREATIVE_MODE_TAB`）。
- 忘记 `register(modBus)` 不会报错，只是注册不生效。
- 1.20.1 仍有 `CreativeModeTab.TAB_MISC` 等常量；自定义标签页推荐上面的 builder 写法。

## 4. 命令

```java
@SubscribeEvent
public static void onRegisterCommands(RegisterCommandsEvent event) {
    CommandDispatcher<CommandSourceStack> d = event.getDispatcher();
    d.register(Commands.literal("mymod")
        .then(Commands.literal("hello")
            .executes(ctx -> {
                ctx.getSource().sendSuccess(() -> Component.literal("hi"), false);
                return 1;
            })));
}
```
`sendSuccess` 在 1.20.1 的签名是 `(Supplier<Component>, boolean)`。

## 5. 客户端隔离

```java
DistExecutor.unsafeRunWhenOn(Dist.CLIENT, () -> () -> ClientSetup.init());
```
- `net.minecraftforge.fml.DistExecutor`、`net.minecraftforge.api.distmarker.Dist`。
- 客户端专用类上可加 `@OnlyIn(Dist.CLIENT)`；**common 代码里不能出现 `net.minecraft.client.*` 的静态引用**（服务端会 `NoClassDefFoundError`）。
- 客户端初始化推荐 `@Mod.EventBusSubscriber(modid = MODID, bus = Bus.MOD, value = Dist.CLIENT)` + `FMLClientSetupEvent`。

## 6. 数据生成

```java
@Mod.EventBusSubscriber(modid = MODID, bus = Mod.EventBusSubscriber.Bus.MOD)
public final class DataGenerators {
    @SubscribeEvent
    public static void gatherData(GatherDataEvent event) {   // net.minecraftforge.data.event.GatherDataEvent（1.20.1 包名）
        DataGenerator gen = event.getGenerator();
        // gen.addProvider(event.includeServer(), new MyRecipeProvider(gen));
        // gen.addProvider(event.includeClient(), new MyItemModelProvider(gen, event.getExistingFileHelper()));
    }
}
```
输出目录 `src/generated/resources`，由 `gradlew runData` 触发；构建脚本需把该目录加入 resources。

## 7. 元数据

`src/main/resources/META-INF/mods.toml`：
```toml
modLoader="javafml"
loaderVersion="${loader_version_range}"   # [47,)
license="${mod_license}"

[[mods]]
modId="${mod_id}"
version="${mod_version}"
displayName="${mod_name}"
authors="${mod_authors}"
description='''${mod_description}'''

[[dependencies.${mod_id}]]
    modId="forge"
    mandatory=true
    versionRange="${forge_version_range}"   # [47,)
    ordering="NONE"
    side="BOTH"

[[dependencies.${mod_id}]]
    modId="minecraft"
    mandatory=true
    versionRange="${minecraft_version_range}" # [1.20.1,1.21)
    ordering="NONE"
    side="BOTH"
```
`pack.mcmeta`：`"pack_format": 15`。

## 8. 1.20.1 专属坑

- `jar { finalizedBy 'reobfJar' }` 不能删；`build/libs` 里才是可分发的 reobf 产物。
- `mappings channel: 'official', version: '1.20.1'` 必须与 MC 版本一致。
- `TickEvent` 1.20.1 仍用 `getPhase()`；把 1.20.2+ 的 `ServerTickEvent.Pre/Post` 抄过来会编译失败。
- `Component.literal` 在 `net.minecraft.network.chat.Component`；1.19+ 起 `new TextComponent` 已移除。
- `sendSuccess` / `sendFailure` 要 `Supplier<Component>`。
- 资源路径必须全小写，`textures/item/Ruby.png` 在 Windows 上能读，打包到其他平台会挂。
