# Slack

Claude と Slack をつなぐ方法は3つある。「通知だけ」で足りる人が多い。

| 選び方 | 何ができるか | 要るもの |
|---|---|---|
| 1. 通知だけ | 作業完了・許可待ちを Mac の通知で受ける（Slack は使わない） | 初期セットアップの「通知」を「鳴らす」にする。これで完了 |
| 2. 公式の Claude in Slack | Slack で `@Claude` に頼むと、クラウド上の Claude Code が GitHub のリポジトリに対して作業する | Pro/Max（Team/Enterprise は Claude Tag）・ワークスペース管理者が Claude アプリを入れる・GitHub 連携 |
| 3. 自前の Bot | 自分の Mac の Claude Code を Slack の「AI 社員」として動かす（投稿・メンションで起動・依頼スレッドの自動再開） | Slack App を自分で作る（管理者の承認が要ることがある）・Node.js・Mac を起動したままにする |

## 2. 公式の Claude in Slack / Claude Tag

- Pro/Max: ワークスペース管理者が Slack App Marketplace から「Claude」を入れ、各自が App Home で自分の Claude アカウントをつなぐ。`/invite @Claude` したチャンネルで `@Claude` に頼む。作業は claude.ai のクラウドセッションで行われ、対象は GitHub のリポジトリ（手元の Mac のファイルは触らない）。詳細: https://code.claude.com/docs/en/slack
- Team/Enterprise: 組織の Owner が claude.ai の管理画面で Claude Tag を有効にする。詳細: https://claude.com/docs/claude-tag/overview

## 3. 自前の Bot（slack-agent）

このマーケットプレイスのプラグイン `slack-agent` が、Slack App の作成から常駐 Bot の登録までを一気通貫で案内する。

```
/plugin install slack-agent@claude-code-starter
```

入れたあと Claude に「Slack 連携をセットアップして」と頼む。Bot の表示名・自分の Slack ユーザー ID・作業フォルダ・ワークスペース URL を聞かれ、トークンは画面に出さずに保存される。
注意: Bot を招待したチャンネルの人は誰でもあなたの Claude Code を動かせる。招待先は選ぶ。
