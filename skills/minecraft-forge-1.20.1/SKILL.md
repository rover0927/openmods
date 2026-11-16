---
name: minecraft-forge-1.20.1
description: Minecraft 1.20.1 Forge（47.x）模组开发：Java 17 + ForgeGradle 6 + Gradle 8.8 工程结构、DeferredRegister 注册、双事件总线、资源与数据生成、gradlew build/runClient/runData 的构建与启动、国内镜像配置与常见坑。只覆盖 Java + 1.20.1，不涉及 Fabric / NeoForge / Kotlin / 1.20.2+。
---

# Minecraft 1.20.1 Forge 模组开发

> 适用范围：**仅 Java + Minecraft 1.20.1 + Forge 47.x**（ForgeGradle 6，Gradle 8.8，JDK 17，official/mojmap 映射，mods.toml + pack_format 15）。
> 本技能不覆盖 Fabric、NeoForge、1.20.2 之后的版本、Kotlin、数据包/资源包独立开发。
> 需要精确签名时读 `references/forge-1.20.1-api.md`；不要凭记忆写 API。

## 1. 版本钉选（不要改）

| 项 | 值 |
|---|---|
| Minecraft | 1.20.1 |
| Forge | 47.x（本项目 MDK：47.4.10） |
| ForgeGradle | 6.0.54（`id 'net.minecraftforge.gradle' version '[6.0,6.2)'`） |
| Gradle wrapper | 8.8 |
| JDK（运行 Gradle 与编译） | 17（`java.toolchain.languageVersion = JavaLanguageVersion.of(17)`） |
| 映射 | `official` / `1.20.1` |
| 元数据 | `META-INF/mods.toml` + `pack.mcmeta`（`pack_format: 15`） |

Forge 47.x 与 1.20.1 严格对应；换 Forge 小版本只改 `gradle.properties` 的 `forge_version`，不要动 ForgeGradle / Gradle 大版本。
1.20.2 起 Forge 不再发版（只有 NeoForge），遇到 1.20.2+ 需求要明确告知用户本技能不适用。

## 2. 工程结构

```
<project>/
├── build.gradle              # FG6 + runs{client,server,gameTestServer,data}
├── gradle.properties         # minecraft_version/forge_version/mod_* 变量
├── settings.gradle           # pluginManagement（镜像 + Forge maven）+ foojay
├── gradle/wrapper/…          # Gradle 8.8
├── src/main/java/<pkg>/
│   ├── <Mod>.java            # @Mod 入口 + DeferredRegister
│   ├── registry/             # ModItems / ModBlocks / ModBlockEntities…
│   ├── event/                # @EventBusSubscriber 监听器
│   └── client/               # 仅客户端（渲染/按键/粒子）
├── src/main/resources/
│   ├── META-INF/mods.toml
│   ├── pack.mcmeta
│   └── assets/<modid>/{models/item,blockstates,textures/{item,block},lang}
└── run/                      # runClient 的工作目录（日志在 run/logs/latest.log）
```

`modid` 必须小写、匹配 `[a-z][a-z0-9_]{1,63}`，并且与 `@Mod("<modid>")`、`gradle.properties` 的 `mod_id`、资源目录名完全一致。

## 3. 入口与注册

```java
@Mod(MyMod.MODID)
public class MyMod {
    public static final String MODID = "mymod";
    public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, MODID);
    public static final DeferredRegister<Block> BLOCKS = DeferredRegister.create(ForgeRegistries.BLOCKS, MODID);

    public static final RegistryObject<Block> RUBY_BLOCK = BLOCKS.register("ruby_block",
        () -> new Block(BlockBehaviour.Properties.of().strength(3.0F).requiresCorrectToolForDrops()));
    public static final RegistryObject<Item> RUBY = ITEMS.register("ruby",
        () -> new Item(new Item.Properties()));

    // 47.3+ 的官方 MDK 写法：构造器接收 FMLJavaModLoadingContext（可注入），不再调 get()
    public MyMod(FMLJavaModLoadingContext context) {
        IEventBus modBus = context.getModEventBus();
        BLOCKS.register(modBus);
        ITEMS.register(modBus);
        MinecraftForge.EVENT_BUS.register(this);
    }
}
```

`FMLJavaModLoadingContext.get()` 在 47.4.x 仍可用但已弃用（会打印 warning）；新代码一律用构造器注入，和官方 MDK 保持一致。

铁律：
- `DeferredRegister` 必须 `register(modBus)`，漏了不报错但注册不生效。
- 1.20.1 方块属性是 `BlockBehaviour.Properties.of()`（`AbstractBlock` 是 1.16.5 的写法）。
- 方块物品用 `BlockItem`：`ITEMS.register("ruby_block", () -> new BlockItem(RUBY_BLOCK.get(), new Item.Properties()))`。
- 创造模式标签页：1.20.1 还有 `CreativeModeTab.TAB_MISC` 常量；自定义标签页用 `DeferredRegister<CreativeModeTab>` + `CreativeModeTab.builder()`。
- 注册名只能小写 `[a-z0-9_./-]`，不要用大写或空格。

## 4. 双事件总线

| 总线 | 获取 | 用途 |
|---|---|---|
| mod bus | `FMLJavaModLoadingContext.get().getModEventBus()` | 注册、`FMLCommonSetupEvent`、`FMLClientSetupEvent`、`GatherDataEvent`、`RegisterCapabilitiesEvent` |
| game bus | `MinecraftForge.EVENT_BUS` | 运行时：玩家/实体/方块/命令/服务器生命周期 |

```java
@Mod.EventBusSubscriber(modid = MyMod.MODID, bus = Mod.EventBusSubscriber.Bus.FORGE)
public final class ModEvents {
    @SubscribeEvent
    public static void onServerStarting(ServerStartingEvent e) { }
}
```
`@SubscribeEvent` 的包是 `net.minecraftforge.eventbus.api.SubscribeEvent`（不是老版 `fml.common.eventhandler`）。
客户端专用初始化用 `@Mod.EventBusSubscriber(modid = MODID, bus = Bus.MOD, value = Dist.CLIENT)` 或 `DistExecutor.unsafeRunWhenOn(Dist.CLIENT, () -> () -> …)`；**服务端不能加载任何 `net.minecraft.client.*` 类**。

常用事件与签名见 `references/forge-1.20.1-api.md` §3。

## 5. 资源文件（缺一个就是紫黑方块）

物品 `assets/<modid>/models/item/<name>.json`：
```json
{ "parent": "minecraft:item/generated", "textures": { "layer0": "<modid>:item/<name>" } }
```
方块需要三件套：`blockstates/<name>.json` + `models/block/<name>.json` + `models/item/<name>.json`（父模型指向方块模型），贴图在 `textures/block/<name>.png`。
语言文件 `assets/<modid>/lang/en_us.json`、`zh_cn.json`，键为 `item.<modid>.<name>` / `block.<modid>.<name>`。

贴图规格：物品/方块 16×16 PNG。建模子代理产出的 3D 造型最终要落到这个尺寸的贴图 + 简单 JSON 模型（或 `forge:obj` 之类的扩展模型），不要直接把高分辨率渲染图塞进 `textures/`。

## 6. 构建与运行

```bat
gradlew.bat build          :: 产物 build/libs/<modid>-<version>.jar（已 reobf）
gradlew.bat runClient      :: 开发客户端，工作目录 run/
gradlew.bat runServer      :: 专用服务器（首次要 run/eula.txt 里 eula=true）
gradlew.bat runData        :: 数据生成 → src/generated/resources/
gradlew.bat --stop         :: 停 daemon
```
首次构建要下 Forge/MCP 并反编译；`runClient` 首次还要补全 assets（实测 633MB，约 4 分钟，2.3MB/s）。
实测基准（2026-11，i7 / 15G 内存 / 国内家用宽带）：缓存预热后 `build` 2m50s，`runClient` 从启动到主菜单约 25 秒。
验证客户端是否真的起来了，看 `run/logs/latest.log`（**日志是 GBK，grep 要加 `-a`**），四个标记依次出现即成功：

```
ModLauncher running: args [--launchTarget, forgeclientuserdev, --fml.forgeVersion, 47.4.10, --fml.mcVersion, 1.20.1]
Backend library: LWJGL version 3.3.1 build 7
Forge mod loading, version 47.4.10, for MC 1.20.1 with MCP 20230612.114412
Sound engine started
```
再看到自己 mod 的 `HELLO FROM COMMON SETUP` / `HELLO FROM CLIENT SETUP` 就说明 mod 被加载了。
调试期要关客户端：直接杀 java 进程（`runClient` 会以 `exit value -1` 结束，属正常，不是构建失败）；崩溃看 `run/crash-reports/`。

## 7. 国内镜像（必须配，否则会卡在 Forge maven）

`maven.minecraftforge.net` 在国内经常十几秒无响应，甚至只在握手阶段就吊住。**实测可用**的镜像基址：

| 用途 | 地址 | 实测 |
| --- | --- | --- |
| Forge / MCP maven | `https://unicom.mirrors.ustc.edu.cn/bmclapi/` | 直连 200、无跳转、6MB/s ← **首选** |
| （备选）Forge / MCP | `https://bmclapi2.bangbang93.com/maven/` | 302→cernet→ustc 链，偶发 404/半截，慢 |
| Gradle 发行版 | `https://mirrors.cloud.tencent.com/gradle/` | 206/200，稳定 |
| Mojang libraries | 官方 `https://libraries.minecraft.net/` | 实测 1MB/s，**不用换** |
| 游戏 resources | 官方 `https://resources.download.minecraft.net/` | 实测 2.3MB/s，633MB 约 4 分钟，**不用换** |

`maven.aliyun.com` / `repo.huaweicloud.com` / `mirrors.cloud.tencent.com/nexus` 都**不代理** Forge 的 `net/minecraftforge/*`（实测 404），别浪费时间。

ForgeGradle 里有两类下载链路，**必须分别处理**：

1. **走 Gradle 仓库的**（`net.minecraftforge:forge:*`、plugin 解析）
   → 在 `settings.gradle` 的 `pluginManagement.repositories`、`build.gradle` 的 `repositories` 首位放镜像；并且用
   `gradle.beforeProject { p -> p.repositories.whenObjectAdded { repo -> …改为镜像 URL } }`
   在仓库**刚被加进来**时改写 —— ForgeGradle 在配置阶段就开始解析，放到 `projectsEvaluated` 已经太晚。

2. **不走仓库、拿编译期常量直连的**（`Utils.FORGE_MAVEN` / `MOJANG_MAVEN` 是 `static final String`，会被内联，运行期改不了）
   → 只能把这些文件**预先按原路径摆进缓存** `<GRADLE_USER_HOME>/caches/forge_gradle/maven_downloader/`：
   ```
   net/minecraftforge/installertools/1.3.2/installertools-1.3.2-fatjar.jar
   net/minecraftforge/mergetool/1.1.7/mergetool-1.1.7-api.jar
   net/minecraftforge/renamer/2.0.4/renamer-2.0.4-all.jar
   de/oceanlabs/mcp/mcp_config/1.20.1/mcp_config-1.20.1.zip
   de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412.zip
   net/minecraftforge/forge/1.20.1-47.4.10/forge-<v>-{installer,universal,userdev,sources}.jar
   ```
   **两个 mcp_config 版本号都不能少**：裸 `1.20.1` 给 `OfficialChannelProvider`，带时间戳的给 `MCPRepo` 跑
   joined/strip 步骤。缺任何一个，`MavenArtifactDownloader` 会转去走 Gradle 解析（镜像是第 1 个仓库也不生效），
   报 `Could not resolve dependency: de.oceanlabs.mcp:mcp_config:…`。
   同目录的 `.md5` 也一起放（FG 下完会校验，缺了就回头找官方源）。`mc_gradle` 已内置这步（`seedMavenCache`），
   手工在别的工程里跑就照这个清单 `curl` 一遍。

3. **必须关掉 ForgeGradle 的开机自检**（这是最阴的一个坑）：
   ```
   systemProp.net.minecraftforge.gradle.check.certs=false   # 写进 gradle.properties
   ```
   `UserDevPlugin.apply` 会调 `EnvironmentChecks.checkEnvironment`，用 `HttpURLConnection` 去
   `https://maven.minecraftforge.net/` 做一次 SSL 握手自检，**没有 connect/read 超时**。线路一卡，
   构建就停在这里，日志停在 `Daemon will be stopped at the end of the build` 之后再无任何输出（`jstack` 能看到
   线程卡在 `SSLTransport.decode` → `EnvironmentChecks.testServerConnection`）。关掉它只跳过证书/连通性自检，不影响产物。

4. 内存：官方 `org.gradle.jvmargs=-Xmx3G`。机器空闲内存 < 3G 时 daemon 会被系统静默杀掉，
   报 `The message received from the daemon indicates that the daemon has disappeared`。模板已调到 `-Xmx2G`，
   更紧就 `-Xmx1280m`（实测可完成 build + runClient）。

## 8. 与建模子代理协作

造型（方块/物品/生物外观）交给建模子代理（`spawn_modeling_subagent`），不要自己手写几何：
- 派发时写清：目标尺寸（物品 16×16、方块 16×16、生物按碰撞箱）、配色、要在 Minecraft 里读得清的轮廓；
- 子代理产出的是画布里的 bbmodel；
- 回到 Java 侧需要的是：`textures/item|block/<name>.png` + `models/item/<name>.json`（简单物品直接用 `item/generated`；复杂造型用 `forge:obj` 或拆成多个 `elements` 的 JSON 模型）；
- 派发完不要轮询，结算后系统会自动开汇总回合；汇总时核对贴图尺寸与资源路径是否齐全。

## 9. 常见坑

1. **Gradle/JDK 配对**：Gradle 8.8 需要 JDK 17+；`JAVA_HOME` 指错 JDK 8 会在配置阶段直接失败。
2. **reobfJar**：`jar { finalizedBy 'reobfJar' }` 必须保留；`build/libs` 里 dev 版 jar 不能直接发给玩家。
3. **mods.toml 占位符**：`${mod_id}` 等由 `processResources` 的 `expand` 替换，模板里别写成 `{{…}}`（那是脚手架语法）。
4. **`pack_format`**：1.20.1 是 15，写 6 会在资源包校验时报警告。
5. **注册名大小写/非法字符**：`DeferredRegister` 不校验，运行时才崩。
6. **客户端类泄漏到服务端**：`runServer` 崩在 `NoClassDefFoundError: net/minecraft/client/...`，说明没用 `DistExecutor` / `Dist.CLIENT` 隔离。
7. **`runClient` 卡在 “Downloading assets”**：官方 resources 源实测 2.3MB/s 够用，等着就行；不要重复 Ctrl+C，会留下半截 assets。
8. **改了 `build.gradle` 的 mappings 不生效**：需要 `gradlew clean` 后重建（FG 缓存了反编译结果）。
9. **`runData` 覆盖手写资源**：数据生成输出到 `src/generated/resources`，不要把手写 JSON 放进那个目录。
10. **`daemon has disappeared`**：内存不够被系统杀，调小 `org.gradle.jvmargs`（见 §7.4）。
11. **配置阶段无声挂起**：`EnvironmentChecks` 的 SSL 自检无超时，必须 `systemProp.net.minecraftforge.gradle.check.certs=false`（见 §7.3）。
12. **`Could not create 1.20.1 official mappings due to missing MCP's tsrg`**：`mcp_config:1.20.1`（**不带时间戳**的那个版本号）没进 `maven_downloader` 缓存，FG 会 `return null` 而不报下载失败，只能靠这条看似无关的报错倒推。按 §7.2 清单补齐。
13. **`runClient` 报 `java.lang.IllegalStateException: Failed to read asset index`**：assets 目录不在 `GRADLE_USER_HOME/caches/forge_gradle/assets`；换 `GRADLE_USER_HOME` 后要重新下或把两个缓存目录一起搬。
14. **进游戏物品是黑紫格**：Minecraft 把「模型缺失」和「贴图缺失」都渲染成同一个黑紫格，光看画面分不出来。两个都要有：
    - `assets/<modid>/models/item/<id>.json`（`parent: minecraft:item/generated` + `layer0: <modid>:item/<id>`）；
    - `assets/<modid>/textures/item/<id>.png`（**PNG 必须是 8bit RGB/RGBA、16×16**，文件名全小写）。
    `run/logs/latest.log` 里有 `Unable to load model: '<modid>:<id>#inventory'` 就是模型没找到（先查拼写/路径）；一条都没有但仍是黑紫，才是贴图问题。
15. **创造栏里看不到自己的物品**：`DeferredRegister` 只把物品放进注册表，**不会**进创造模式物品栏。要么 `event.accept(...)` 在 `BuildCreativeModeTabContentsEvent` 里挂到原版页，要么自建 `CreativeModeTab`（`.displayItems((p,o) -> o.accept(MY_ITEM.get()))`）。自建的 tab 还要 `itemGroup.<modid>.<tabid>` 语言键，否则标签页显示成原始 key。
16. **MDK 示例物品变成黑紫格**：模板自带的 `example_block` / `example_item` 没有任何模型和贴图，留着它们会在创造栏里显示为黑紫格，看起来像"自己的贴图坏了"。脚手架已改为把它们整段替换成真实物品；手改的工程直接把 `EXAMPLE_*` 三个注册删掉最快。

## 10. 交付前检查

- [ ] `gradlew.bat build` exit 0，`build/libs/<modid>-<version>.jar` 存在
- [ ] `runClient` 能进主菜单，`run/logs/latest.log` 有 `Forge mod loading` 且无 `ERROR`
- [ ] 每个注册项都有对应的 `models/item` / `blockstates` / `textures` / `lang` 条目
- [ ] `mods.toml` 的 `modId`、`@Mod` 值、资源目录名、`gradle.properties` 的 `mod_id` 四者一致
- [ ] 没有 `net.minecraft.client.*` 出现在 common 代码里
